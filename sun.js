// Sunrise/sunset calculation based on the NOAA solar position algorithm.
// Accurate to within roughly a minute, which is more than sufficient for
// classifying drive time as day or night.

function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

function julianDay(date) {
  const time = date.getTime();
  return time / 86400000 + 2440587.5;
}

function julianCentury(jd) {
  return (jd - 2451545.0) / 36525.0;
}

function geomMeanLongSun(t) {
  let l = 280.46646 + t * (36000.76983 + t * 0.0003032);
  while (l > 360) l -= 360;
  while (l < 0) l += 360;
  return l;
}

function geomMeanAnomalySun(t) {
  return 357.52911 + t * (35999.05029 - 0.0001537 * t);
}

function eccentricityEarthOrbit(t) {
  return 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
}

function sunEqOfCenter(t) {
  const m = geomMeanAnomalySun(t);
  const mrad = toRad(m);
  const sinm = Math.sin(mrad);
  const sin2m = Math.sin(2 * mrad);
  const sin3m = Math.sin(3 * mrad);
  return sinm * (1.914602 - t * (0.004817 + 0.000014 * t))
    + sin2m * (0.019993 - 0.000101 * t)
    + sin3m * 0.000289;
}

function sunTrueLong(t) {
  return geomMeanLongSun(t) + sunEqOfCenter(t);
}

function sunAppLong(t) {
  return sunTrueLong(t) - 0.00569 - 0.00478 * Math.sin(toRad(125.04 - 1934.136 * t));
}

function meanObliquityOfEcliptic(t) {
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  return 23.0 + (26.0 + seconds / 60.0) / 60.0;
}

function obliquityCorrection(t) {
  const e0 = meanObliquityOfEcliptic(t);
  const omega = 125.04 - 1934.136 * t;
  return e0 + 0.00256 * Math.cos(toRad(omega));
}

function sunDeclination(t) {
  const e = toRad(obliquityCorrection(t));
  const lambda = toRad(sunAppLong(t));
  const sint = Math.sin(e) * Math.sin(lambda);
  return toDeg(Math.asin(sint));
}

function eqOfTime(t) {
  const epsilon = toRad(obliquityCorrection(t));
  const l0 = toRad(geomMeanLongSun(t));
  const e = eccentricityEarthOrbit(t);
  const m = toRad(geomMeanAnomalySun(t));
  const y = Math.tan(epsilon / 2) * Math.tan(epsilon / 2);
  const sin2l0 = Math.sin(2 * l0);
  const sinm = Math.sin(m);
  const cos2l0 = Math.cos(2 * l0);
  const sin4l0 = Math.sin(4 * l0);
  const sin2m = Math.sin(2 * m);
  const etime = y * sin2l0 - 2 * e * sinm + 4 * e * y * sinm * cos2l0
    - 0.5 * y * y * sin4l0 - 1.25 * e * e * sin2m;
  return toDeg(etime) * 4;
}

function hourAngleSunrise(lat, decl) {
  const latRad = toRad(lat);
  const declRad = toRad(decl);
  const zenith = toRad(90.833);
  const cosH = (Math.cos(zenith) - Math.sin(latRad) * Math.sin(declRad))
    / (Math.cos(latRad) * Math.cos(declRad));
  const clamped = Math.max(-1, Math.min(1, cosH));
  return toDeg(Math.acos(clamped));
}

// Returns { sunrise, sunset } as Date objects in local time for the given
// calendar date (year/month/day taken from the Date object, time ignored).
export function getSunTimes(date, lat, lon) {
  const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
  const jd = julianDay(noon);
  const t = julianCentury(jd);
  const decl = sunDeclination(t);
  const eqTime = eqOfTime(t);
  const hourAngle = hourAngleSunrise(lat, decl);

  const solarNoonMinutes = 720 - 4 * lon - eqTime;
  const sunriseMinutes = solarNoonMinutes - 4 * hourAngle;
  const sunsetMinutes = solarNoonMinutes + 4 * hourAngle;

  const tzOffsetMinutes = -noon.getTimezoneOffset();
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);

  const sunrise = new Date(dayStart.getTime() + (sunriseMinutes + tzOffsetMinutes) * 60000);
  const sunset = new Date(dayStart.getTime() + (sunsetMinutes + tzOffsetMinutes) * 60000);

  return { sunrise, sunset };
}
