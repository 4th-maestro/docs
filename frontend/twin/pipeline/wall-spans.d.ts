type Point = [number, number]
type Opening = { a: Point; b: Point; rooms: string[] }

export function wallSpans(a: Point, b: Point, roomId: string, openings: Opening[]): [Point, Point][]
