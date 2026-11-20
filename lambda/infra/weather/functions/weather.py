"""Collect one KMA ultra-short observation without logging API credentials."""

import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode
from urllib.request import urlopen

import boto3
from botocore.config import Config

LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)
KST = timezone(timedelta(hours=9))
ENDPOINT = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst"
FIELDS = {"T1H": "tempC", "REH": "humidity", "WSD": "windMs", "RN1": "precipMm"}
AWS_CONFIG = Config(
    connect_timeout=2,
    read_timeout=3,
    retries={"total_max_attempts": 2, "mode": "standard"},
)


class WeatherError(Exception):
    """A fixed, credential-free reason safe to return and log."""


def parse_location(location):
    if not re.fullmatch(r"[1-9][0-9]{0,2},[1-9][0-9]{0,2}", location):
        raise WeatherError("INVALID_LOCATION")
    nx, ny = map(int, location.split(","))
    if nx > 149 or ny > 253:
        raise WeatherError("INVALID_LOCATION")
    return nx, ny


def observation_time(now):
    """KMA's 2026-10 guide: HH00 observations are available after HH:10 KST."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise WeatherError("TIMEZONE_REQUIRED")
    return (now.astimezone(KST) - timedelta(minutes=10)).replace(
        minute=0, second=0, microsecond=0
    )


def service_key(secret_string):
    """Accept plain text or {serviceKey: ...}, encoded or decoded exactly once."""
    if not isinstance(secret_string, str):
        raise WeatherError("INVALID_SECRET")
    value = secret_string.strip()
    if value.startswith("{"):
        try:
            value = json.loads(value).get("serviceKey")
        except (ValueError, AttributeError):
            raise WeatherError("INVALID_SECRET") from None
    if not isinstance(value, str) or not value.strip():
        raise WeatherError("INVALID_SECRET")
    value = unquote(value.strip())
    if any(character.isspace() for character in value):
        raise WeatherError("INVALID_SECRET")
    return value


@lru_cache(maxsize=1)
def secrets_client():
    return boto3.client("secretsmanager", region_name="ap-northeast-2", config=AWS_CONFIG)


@lru_cache(maxsize=1)
def weather_table(name):
    return boto3.resource("dynamodb", region_name="ap-northeast-2", config=AWS_CONFIG).Table(name)


def fetch_observation(key, location, observed_at):
    nx, ny = parse_location(location)
    query = urlencode({
        "serviceKey": key,
        "pageNo": 1,
        "numOfRows": 100,
        "dataType": "JSON",
        "base_date": observed_at.strftime("%Y%m%d"),
        "base_time": observed_at.strftime("%H%M"),
        "nx": nx,
        "ny": ny,
    })
    try:
        # One request only. In particular, do not log HTTPError: it contains the key URL.
        with urlopen(f"{ENDPOINT}?{query}", timeout=10) as response:
            return json.loads(response.read(1_000_000))
    except (HTTPError, URLError, TimeoutError, OSError):
        raise WeatherError("KMA_HTTP_ERROR") from None
    except (ValueError, UnicodeError):
        # KMA's gateway may return XML even when JSON was requested (e.g. invalid key).
        raise WeatherError("KMA_INVALID_JSON") from None


def observation_item(payload, location, observed_at):
    """Validate one grid/hour before storing the agreed simulator data contract."""
    nx, ny = parse_location(location)
    try:
        response = payload["response"]
        if str(response["header"]["resultCode"]) != "00":
            raise WeatherError("KMA_API_ERROR")
        rows = response["body"]["items"]["item"]
        if not isinstance(rows, list) or not rows:
            raise WeatherError("KMA_NO_OBSERVATIONS")
        values = {}
        for row in rows:
            category = row["category"]
            if category not in FIELDS:
                continue
            if (
                str(row["baseDate"]) != observed_at.strftime("%Y%m%d")
                or str(row["baseTime"]).zfill(4) != observed_at.strftime("%H%M")
                or int(row["nx"]) != nx
                or int(row["ny"]) != ny
            ):
                raise WeatherError("KMA_OBSERVATION_MISMATCH")
            value = Decimal(str(row["obsrValue"]))
            if not value.is_finite() or value <= -900:
                raise WeatherError("KMA_INVALID_VALUE")
            values[FIELDS[category]] = value
        if set(values) != set(FIELDS.values()):
            raise WeatherError("KMA_MISSING_FIELDS")
        if not -100 <= values["tempC"] <= 100 or not 0 <= values["humidity"] <= 100:
            raise WeatherError("KMA_INVALID_VALUE")
        if values["windMs"] < 0 or values["precipMm"] < 0:
            raise WeatherError("KMA_INVALID_VALUE")
        return {
            "location": location,
            "ts": observed_at.isoformat(timespec="seconds"),
            **values,
            "source": "kma-ultra-srt-ncst",
            "ttl": int((observed_at + timedelta(days=30)).timestamp()),
        }
    except (KeyError, TypeError, ValueError, InvalidOperation):
        raise WeatherError("KMA_INVALID_OBSERVATION") from None


def handler(event, context):
    """Record failures as structured logs; let the next 30-minute tick try again."""
    try:
        location = os.environ["LOCATION"]
        parse_location(location)
        table_name = os.environ["WEATHER_TABLE"]
        secret_id = os.environ["SECRET_ID"]
        observed_at = observation_time(datetime.now(KST))
        secret = secrets_client().get_secret_value(SecretId=secret_id)
        key = service_key(secret.get("SecretString"))
        payload = fetch_observation(key, location, observed_at)
        item = observation_item(payload, location, observed_at)
        # Repeated collection of the same grid/hour replaces the same item.
        weather_table(table_name).put_item(Item=item)
        result = {"status": "stored", "location": location, "ts": item["ts"]}
        LOGGER.info(json.dumps(result))
        return result
    except Exception as error:
        # Returning failure is deliberate: the handover requires no retry storm.
        # Never log exception text/tracebacks, raw responses, the event, or the key.
        reason = str(error) if isinstance(error, WeatherError) else type(error).__name__
        result = {"status": "failed", "reason": reason}
        LOGGER.error(json.dumps(result))
        return result
