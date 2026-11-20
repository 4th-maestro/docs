export type Appearance = {
  facadeColor: string
  facadeOpacity: number
  roofColor: string
  roofOpacity: number
  interiorBrightness: number
  lighting: number
  cameraAngle: number
}

export function resolveAppearance(
  building: { size: { w: number; d: number }; facade?: { glassColor?: string; roofColor?: string } },
  saved?: Partial<Appearance>,
): Appearance
