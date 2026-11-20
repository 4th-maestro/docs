export type Appearance = {
  facadeColor: string
  facadeOpacity: number
  roofColor: string
  roofOpacity: number
  interiorBrightness: number
  lighting: number
  cameraAngle: number
}

export type AppearanceBuilding = {
  size: { w: number; d: number }
  floorHeight?: number
  facade?: { glassColor?: string; roofColor?: string; roofProfile?: unknown[]; dome?: { height?: number } }
}

export function resolveAppearance(
  building: AppearanceBuilding,
  saved?: Partial<Appearance>,
  floors?: { id: string; below?: boolean; shellFootprint?: unknown[] }[],
): Appearance
