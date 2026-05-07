import { readFileSync } from "node:fs";

// Parse ISO 6709 short form: ±DDMM±DDDMM or ±DDMMSS±DDDMMSS.
function parseCoord(coord: string): [number, number] | null {
  const m = coord.match(
    /^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/,
  );
  if (!m) return null;
  const [, latS, latD, latM, latSec, lonS, lonD, lonM, lonSec] = m;
  const lat =
    (latS === "+" ? 1 : -1) *
    (Number(latD) + Number(latM) / 60 + Number(latSec || 0) / 3600);
  const lon =
    (lonS === "+" ? 1 : -1) *
    (Number(lonD) + Number(lonM) / 60 + Number(lonSec || 0) / 3600);
  return [lat, lon];
}

export type TzCoords = Map<string, [number, number]>;

export function loadTzCoords(): TzCoords {
  const candidates = [
    "/usr/share/zoneinfo/zone1970.tab",
    "/usr/share/zoneinfo/zone.tab",
  ];
  let content = "";
  for (const p of candidates) {
    try {
      content = readFileSync(p, "utf8");
      break;
    } catch {}
  }
  if (!content) throw new Error("no zone.tab found in /usr/share/zoneinfo");

  const out: TzCoords = new Map();
  for (const line of content.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const cols = line.split("\t");
    // zone1970.tab: codes coords TZ comments
    // zone.tab:     code  coords TZ comments
    if (cols.length < 3) continue;
    const coord = cols[1];
    const tz = cols[2];
    const ll = parseCoord(coord);
    if (ll) out.set(tz, ll);
  }
  return out;
}

// IANA "backward" aliases mapped to the canonical zone in zone.tab. Slack
// returns plenty of these legacy names in user profiles.
const ALIASES: Record<string, string> = {
  // Africa
  "Africa/Asmera": "Africa/Asmara",
  "Africa/Timbuktu": "Africa/Bamako",

  // Americas — Argentina collapse + miscellaneous
  "America/Argentina/ComodRivadavia": "America/Argentina/Catamarca",
  "America/Atka": "America/Adak",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Ensenada": "America/Tijuana",
  "America/Fort_Wayne": "America/Indiana/Indianapolis",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Knox_IN": "America/Indiana/Knox",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "America/Montreal": "America/Toronto",
  "America/Nipigon": "America/Toronto",
  "America/Pangnirtung": "America/Iqaluit",
  "America/Porto_Acre": "America/Rio_Branco",
  "America/Rainy_River": "America/Winnipeg",
  "America/Rosario": "America/Argentina/Cordoba",
  "America/Santa_Isabel": "America/Tijuana",
  "America/Shiprock": "America/Denver",
  "America/Thunder_Bay": "America/Toronto",
  "America/Virgin": "America/Port_of_Spain",
  "America/Yellowknife": "America/Edmonton",

  // Antarctica
  "Antarctica/South_Pole": "Antarctica/McMurdo",

  // Asia
  "Asia/Ashkhabad": "Asia/Ashgabat",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Chongqing": "Asia/Shanghai",
  "Asia/Chungking": "Asia/Shanghai",
  "Asia/Dacca": "Asia/Dhaka",
  "Asia/Harbin": "Asia/Shanghai",
  "Asia/Istanbul": "Europe/Istanbul",
  "Asia/Kashgar": "Asia/Urumqi",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Macao": "Asia/Macau",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Tel_Aviv": "Asia/Jerusalem",
  "Asia/Thimbu": "Asia/Thimphu",
  "Asia/Ujung_Pandang": "Asia/Makassar",
  "Asia/Ulan_Bator": "Asia/Ulaanbaatar",

  // Atlantic / Europe
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Atlantic/Jan_Mayen": "Europe/Oslo",
  "Europe/Belfast": "Europe/London",
  "Europe/Kiev": "Europe/Kyiv",
  "Europe/Nicosia": "Asia/Nicosia",
  "Europe/Tiraspol": "Europe/Chisinau",
  "Europe/Uzhgorod": "Europe/Kyiv",
  "Europe/Zaporozhye": "Europe/Kyiv",

  // Australia
  "Australia/ACT": "Australia/Sydney",
  "Australia/Canberra": "Australia/Sydney",
  "Australia/Currie": "Australia/Hobart",
  "Australia/LHI": "Australia/Lord_Howe",
  "Australia/NSW": "Australia/Sydney",
  "Australia/North": "Australia/Darwin",
  "Australia/Queensland": "Australia/Brisbane",
  "Australia/South": "Australia/Adelaide",
  "Australia/Tasmania": "Australia/Hobart",
  "Australia/Victoria": "Australia/Melbourne",
  "Australia/West": "Australia/Perth",
  "Australia/Yancowinna": "Australia/Broken_Hill",

  // Pacific
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Johnston": "Pacific/Honolulu",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Samoa": "Pacific/Pago_Pago",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Yap": "Pacific/Chuuk",

  // US/* legacy
  "US/Alaska": "America/Anchorage",
  "US/Aleutian": "America/Adak",
  "US/Arizona": "America/Phoenix",
  "US/Central": "America/Chicago",
  "US/East-Indiana": "America/Indiana/Indianapolis",
  "US/Eastern": "America/New_York",
  "US/Hawaii": "Pacific/Honolulu",
  "US/Indiana-Starke": "America/Indiana/Knox",
  "US/Michigan": "America/Detroit",
  "US/Mountain": "America/Denver",
  "US/Pacific": "America/Los_Angeles",
  "US/Samoa": "Pacific/Pago_Pago",

  // Country-style legacy
  GB: "Europe/London",
  "GB-Eire": "Europe/London",
  Eire: "Europe/Dublin",
  Iceland: "Atlantic/Reykjavik",
  Israel: "Asia/Jerusalem",
  Jamaica: "America/Jamaica",
  Japan: "Asia/Tokyo",
  Libya: "Africa/Tripoli",
  Navajo: "America/Denver",
  "NZ-CHAT": "Pacific/Chatham",
  NZ: "Pacific/Auckland",
  Poland: "Europe/Warsaw",
  Portugal: "Europe/Lisbon",
  ROC: "Asia/Taipei",
  ROK: "Asia/Seoul",
  Singapore: "Asia/Singapore",
  Turkey: "Europe/Istanbul",
  "W-SU": "Europe/Moscow",
  PRC: "Asia/Shanghai",
};

export function tzToLatLng(
  coords: TzCoords,
  tz: string,
): [number, number] | null {
  if (!tz) return null;
  return coords.get(tz) ?? coords.get(ALIASES[tz] ?? "") ?? null;
}
