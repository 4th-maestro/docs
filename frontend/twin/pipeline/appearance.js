const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
const range = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

function softerTone(value, fallback) {
  if (!color(value)) return fallback;
  const channels = [1, 3, 5].map(i => parseInt(value.slice(i, i+2), 16));
  return '#' + channels.map((v,i) => Math.round(v * .55 + [171,179,188][i] * .45).toString(16).padStart(2, '0')).join('');
}

export function resolveAppearance(building, saved, floors = []) {
  const facade = building.facade || {};
  const { w, d } = building.size;
  const above = floors.filter(f => !f.below && !/^B\d+F?$/i.test(f.id ?? ''));
  const width = Math.max(1, w, d), depth = Math.max(1, Math.min(w, d));
  const height = above.length * (building.floorHeight || 3.6) + (facade.dome?.height || 0);
  const tower = range((height / depth - .55) / 2, 0, 1, 0);
  const shaped = facade.roofProfile?.length > 2 || !!facade.dome || above.some(f => f.shellFootprint?.length);
  const elongated = range((width / depth - 1) / 2, 0, 1, 0);
  const angle = Math.round(28 - 11 * elongated + 5 * tower);
  return {
    facadeColor:color(saved?.facadeColor) ?? softerTone(facade.glassColor, '#aebfce'),
    facadeOpacity:range(saved?.facadeOpacity, .1, .9, ((shaped ? 45 : 53) - Math.round(13 * tower)) / 100),
    roofColor:color(saved?.roofColor) ?? softerTone(facade.roofColor ?? facade.glassColor, '#c1c9d0'),
    roofOpacity:range(saved?.roofOpacity, .15, 1, shaped ? .58 : .66),
    interiorBrightness:range(saved?.interiorBrightness, 0, 1, ((shaped ? 21 : 28) - Math.round(8 * tower)) / 100),
    lighting:range(saved?.lighting, .55, 1.25, shaped ? .82 : .9),
    cameraAngle:range(saved?.cameraAngle, -180, 180, w >= d ? angle : 90 - angle),
  };
}
