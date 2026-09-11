import { cohortPlate, MACHINE } from "./brand.ts";

/**
 * The picture of one badge, standing alone.
 *
 * What a wallet shows for a Cohort Zero badge: the cohort plate carrying the badge's own number,
 * because the number is the point of the badge. The colours are resolved to literals and the file
 * names its own namespace, because a wallet draws it with no stylesheet and nothing else.
 */
export function badgeSvg(number: number, of: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="${MACHINE.ground}"/>` +
    cohortPlate(number, { size: 100, of, palette: MACHINE }) +
    `</svg>`;
}
