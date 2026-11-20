"""Offline contract, timing and failure tests; never call AWS or KMA."""

import copy
import importlib.util
import json
import os
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

SPEC = importlib.util.spec_from_file_location(
    "weather", Path(__file__).resolve().parents[1] / "functions" / "weather.py"
)
weather = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(weather)

# A test grid only, unrelated to any actual building.
LOCATION = "60,127"
OBSERVED_AT = datetime(2026, 11, 20, 15, tzinfo=weather.KST)


def fixture():
    return {"response": {
        "header": {"resultCode": "00", "resultMsg": "OK"},
        "body": {"items": {"item": [
            {"baseDate": "20261120", "baseTime": "1500", "nx": 60, "ny": 127,
             "category": category, "obsrValue": value}
            for category, value in (("T1H", "14.2"), ("REH", "55"), ("WSD", "3.1"), ("RN1", "0"))
        ]}},
    }}


class TimingTests(unittest.TestCase):
    def test_before_publication_uses_previous_hour(self):
        now = datetime(2026, 11, 20, 15, 9, 59, tzinfo=weather.KST)
        self.assertEqual(weather.observation_time(now).hour, 14)

    def test_publication_boundary_uses_current_hour(self):
        now = datetime(2026, 11, 20, 15, 10, tzinfo=weather.KST)
        self.assertEqual(weather.observation_time(now), OBSERVED_AT)

    def test_midnight_rolls_back_date(self):
        now = datetime(2026, 1, 1, 0, 5, tzinfo=weather.KST)
        self.assertEqual(weather.observation_time(now).isoformat(), "2025-12-31T23:00:00+09:00")

    def test_utc_is_converted_to_kst(self):
        now = datetime(2026, 11, 20, 6, 30, tzinfo=timezone.utc)
        self.assertEqual(weather.observation_time(now), OBSERVED_AT)

    def test_naive_time_is_rejected(self):
        with self.assertRaises(weather.WeatherError):
            weather.observation_time(datetime(2026, 11, 20))


class DataContractTests(unittest.TestCase):
    def test_maps_complete_observation_with_decimal_values_and_observation_ttl(self):
        item = weather.observation_item(fixture(), LOCATION, OBSERVED_AT)
        self.assertEqual(item, {
            "location": LOCATION, "ts": "2026-11-20T15:00:00+09:00",
            "tempC": Decimal("14.2"), "humidity": Decimal("55"),
            "windMs": Decimal("3.1"), "precipMm": Decimal("0"),
            "source": "kma-ultra-srt-ncst",
            "ttl": int(OBSERVED_AT.timestamp()) + 30 * 24 * 60 * 60,
        })

    def test_missing_measurement_is_rejected(self):
        payload = fixture()
        payload["response"]["body"]["items"]["item"].pop()
        with self.assertRaisesRegex(weather.WeatherError, "MISSING_FIELDS"):
            weather.observation_item(payload, LOCATION, OBSERVED_AT)

    def test_missing_invalid_or_nonfinite_values_are_rejected(self):
        for value in ("-999", "NaN", "Infinity", "", "unknown"):
            with self.subTest(value=value):
                payload = fixture()
                payload["response"]["body"]["items"]["item"][0]["obsrValue"] = value
                with self.assertRaises(weather.WeatherError):
                    weather.observation_item(payload, LOCATION, OBSERVED_AT)

    def test_invalid_ranges_are_rejected(self):
        for index, value in ((0, "101"), (1, "101"), (2, "-1"), (3, "-1")):
            with self.subTest(index=index):
                payload = fixture()
                payload["response"]["body"]["items"]["item"][index]["obsrValue"] = value
                with self.assertRaises(weather.WeatherError):
                    weather.observation_item(payload, LOCATION, OBSERVED_AT)

    def test_wrong_time_or_grid_is_rejected(self):
        for field, value in (("baseDate", "20261119"), ("baseTime", "1400"), ("nx", 61), ("ny", 128)):
            with self.subTest(field=field):
                payload = fixture()
                payload["response"]["body"]["items"]["item"][0][field] = value
                with self.assertRaisesRegex(weather.WeatherError, "MISMATCH"):
                    weather.observation_item(payload, LOCATION, OBSERVED_AT)

    def test_api_error_and_empty_items_are_rejected(self):
        for payload in (
            {"response": {"header": {"resultCode": "03"}}},
            {"response": {"header": {"resultCode": "00"}, "body": {"items": {"item": []}}}},
            {}, {"response": None},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(weather.WeatherError):
                    weather.observation_item(payload, LOCATION, OBSERVED_AT)

    def test_location_must_be_a_valid_grid(self):
        for location in ("", "98, 76", "0,76", "150,76", "98,254", "35.1,129.1"):
            with self.subTest(location=location):
                with self.assertRaises(weather.WeatherError):
                    weather.parse_location(location)


class RequestTests(unittest.TestCase):
    def test_secret_supports_plain_json_and_encoded_keys_without_losing_plus(self):
        for secret in ("dummy+key/=", "dummy%2Bkey%2F%3D", '{"serviceKey":"dummy%2Bkey%2F%3D"}'):
            self.assertEqual(weather.service_key(secret), "dummy+key/=")

    def test_missing_secret_is_rejected(self):
        for secret in (None, "", "{}", '{"serviceKey":null}', "key\nvalue"):
            with self.subTest(secret=secret):
                with self.assertRaises(weather.WeatherError):
                    weather.service_key(secret)

    @patch.object(weather, "urlopen")
    def test_request_uses_correct_hour_grid_and_exactly_one_key_encoding(self, opener):
        opener.return_value.__enter__.return_value.read.return_value = json.dumps(fixture()).encode()
        payload = weather.fetch_observation("dummy+key/=", LOCATION, OBSERVED_AT)
        self.assertEqual(payload, fixture())
        url = opener.call_args.args[0]
        parameters = parse_qs(urlsplit(url).query)
        self.assertEqual(parameters["serviceKey"], ["dummy+key/="])
        self.assertEqual(parameters["base_date"], ["20261120"])
        self.assertEqual(parameters["base_time"], ["1500"])
        self.assertEqual(parameters["nx"], ["60"])
        self.assertEqual(parameters["ny"], ["127"])
        opener.assert_called_once()

    @patch.object(weather, "urlopen")
    def test_http_failure_is_not_retried_or_exposed(self, opener):
        opener.side_effect = HTTPError("https://example.test?serviceKey=hidden-key", 403, "hidden-key", {}, None)
        with self.assertRaisesRegex(weather.WeatherError, "^KMA_HTTP_ERROR$"):
            weather.fetch_observation("hidden-key", LOCATION, OBSERVED_AT)
        opener.assert_called_once()

    @patch.object(weather, "urlopen")
    def test_xml_error_is_not_treated_as_valid_weather(self, opener):
        opener.return_value.__enter__.return_value.read.return_value = b"<error>invalid key</error>"
        with self.assertRaisesRegex(weather.WeatherError, "KMA_INVALID_JSON"):
            weather.fetch_observation("dummy", LOCATION, OBSERVED_AT)


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "LOCATION": LOCATION, "SECRET_ID": "test-secret", "WEATHER_TABLE": "test-weather",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.secrets = MagicMock()
        self.secrets.get_secret_value.return_value = {"SecretString": "hidden-key"}
        self.table = MagicMock()
        for name, value in (("secrets_client", self.secrets), ("weather_table", self.table)):
            patcher = patch.object(weather, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        clock = patch.object(weather, "datetime")
        self.clock = clock.start()
        self.clock.now.return_value = datetime(2026, 11, 20, 15, 30, tzinfo=weather.KST)
        self.addCleanup(clock.stop)

    @patch.object(weather, "fetch_observation", return_value=fixture())
    def test_repeated_hour_writes_one_key(self, fetcher):
        stored = {}

        def put_item(*, Item):
            stored[(Item["location"], Item["ts"])] = copy.deepcopy(Item)

        self.table.put_item.side_effect = put_item
        for _ in range(2):
            self.assertEqual(weather.handler({}, None)["status"], "stored")
        self.assertEqual(len(stored), 1)
        self.assertEqual(self.table.put_item.call_count, 2)

    @patch.object(weather, "fetch_observation", side_effect=weather.WeatherError("KMA_HTTP_ERROR"))
    def test_fetch_failure_does_not_write(self, fetcher):
        with self.assertLogs(weather.LOGGER, level="ERROR"):
            self.assertEqual(weather.handler({}, None), {"status": "failed", "reason": "KMA_HTTP_ERROR"})
        self.table.put_item.assert_not_called()
        fetcher.assert_called_once()

    @patch.object(weather, "fetch_observation", return_value=fixture())
    def test_aws_failure_does_not_leak_exception_text(self, fetcher):
        self.table.put_item.side_effect = RuntimeError("serviceKey=hidden-key")
        with self.assertLogs(weather.LOGGER, level="ERROR") as captured:
            result = weather.handler({}, None)
        self.assertEqual(result, {"status": "failed", "reason": "RuntimeError"})
        self.assertNotIn("hidden-key", "\n".join(captured.output))
        self.assertNotIn("hidden-key", json.dumps(result))

    def test_empty_secret_does_not_call_kma(self):
        self.secrets.get_secret_value.return_value = {}
        with patch.object(weather, "fetch_observation") as fetcher:
            with self.assertLogs(weather.LOGGER, level="ERROR"):
                self.assertEqual(weather.handler({}, None)["status"], "failed")
            fetcher.assert_not_called()
        self.table.put_item.assert_not_called()


if __name__ == "__main__":
    unittest.main()
