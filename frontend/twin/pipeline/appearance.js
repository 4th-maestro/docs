const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
const range = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

function softerTone(value, fallback) {
  if (!color(value)) return fallback;
  const channels = [1, 3, 5].map(i => parseInt(value.slice(i, i+2), 16));
  return '#' + channels.map((v,i) => Math.round(v * .55 + [171,179,188][i] * .45).toString(16).padStart(2, '0')).join('');
}

export function resolveAppearance(building, saved) {
  const facade = building.facade || {};
  return {
    facadeColor:color(saved?.facadeColor) ?? softerTone(facade.glassColor, '#aebfce'),
    facadeOpacity:range(saved?.facadeOpacity, .1, .9, .53),
    roofColor:color(saved?.roofColor) ?? softerTone(facade.roofColor ?? facade.glassColor, '#c1c9d0'),
    roofOpacity:range(saved?.roofOpacity, .15, 1, .66),
    interiorBrightness:range(saved?.interiorBrightness, 0, 1, .28),
    lighting:range(saved?.lighting, .55, 1.25, .9),
    cameraAngle:range(saved?.cameraAngle, -180, 180, building.size.w >= building.size.d ? 24 : 66),
  };
}
