// Combined gaze is measured for this calibration only. Missing calibration is
// not evidence that a different body shares its height/lean response.
const REQUIRED = {L_SIGN:-1, R_SIGN:-1, L_OFF:0, R_OFF:0, gain:.99};
const SIGNATURE = 'combined-gaze-0914:' + JSON.stringify([-1, -1, 0, 0, .99, 0, false]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const refused = reason => ({supported:false, reason, signature:null});

export function readProfile(storage) {
  let raw;
  try { raw = storage.getItem('gb_walk_cal'); }
  catch (_) { return refused('Saved calibration could not be read.'); }
  if (raw === null || raw === '') return refused('Combined gaze needs a verified calibration.');
  if (typeof raw !== 'string') return refused('Saved calibration could not be read.');
  let calibration;
  try { calibration = JSON.parse(raw); }
  catch (_) { return refused('Saved calibration could not be read.'); }
  if (!calibration || typeof calibration !== 'object' || Array.isArray(calibration)) {
    return refused('Saved calibration could not be read.');
  }
  for (const key of Object.keys(REQUIRED)) {
    if (!own(calibration, key) || !Number.isFinite(calibration[key]) || calibration[key] !== REQUIRED[key]) {
      return refused('Combined gaze has not been verified for this calibration.');
    }
  }
  // Manual calibration and the relay accept numeric 0 as false. Absent turn
  // and SWAP use those existing defaults; required body fields never do.
  const turn = own(calibration, 'turn') ? calibration.turn : 0;
  const swap = own(calibration, 'SWAP') ? calibration.SWAP : false;
  if (!Number.isFinite(turn) || turn !== 0 || !(swap === false || swap === 0)) {
    return refused('Combined gaze has not been verified for this calibration.');
  }
  return {supported:true, reason:'', signature:SIGNATURE};
}

export function profileMatches(storage, expectedSignature) {
  const current = readProfile(storage);
  return current.supported && typeof expectedSignature === 'string' && current.signature === expectedSignature;
}

// A separate, explicit Face choice for a robot already tested with Combined.
// Combined emits absolute pre-swap targets; the shared relay consumes SWAP only.
// This remembers the person's confirmation, not a hardware measurement.
const FACE_PROFILE = 'combined-gaze-3-0914';
const FACE_KEY = 'gb_face_profile';
const bodyName = value => typeof value === 'string' ? value.trim() : '';
export function readFaceWiring(storage) {
  let raw;
  try { raw = storage.getItem('gb_walk_cal'); }
  catch (_) { return refused('Saved leg setup could not be read. Keep Original for now.'); }
  if (raw === null) return {supported:true, reason:'', swapped:false};
  let cal;
  try { cal = JSON.parse(raw); }
  catch (_) { return refused('Saved leg setup could not be read. Keep Original for now.'); }
  if (!cal || typeof cal !== 'object' || Array.isArray(cal)) return refused('Saved leg setup could not be read. Keep Original for now.');
  const swapSetting = own(cal, 'SWAP') ? cal.SWAP : false;
  if (!(swapSetting === false || swapSetting === 0)) return refused('Combined has not been tested with this leg-swap setting. Keep Original for now.');
  return {supported:true, reason:'', swapped:false};
}
export function readFaceSelection(storage, bodyId) {
  const id = bodyName(bodyId);
  if (!id) return refused('Enter this robot’s pairing code.');
  const wiring = readFaceWiring(storage);
  if (!wiring.supported) return wiring;
  let choice;
  try { choice = JSON.parse(storage.getItem(FACE_KEY)); }
  catch (_) { return refused('Choose a Face setup for this robot.'); }
  if (!choice || choice.version !== 1 || choice.profile !== FACE_PROFILE || choice.bodyId !== id || choice.swap !== false) {
    return refused('Choose a Face setup for this robot.');
  }
  return {supported:true, reason:'', source:'face', bodyId:id, signature:FACE_PROFILE + ':' + JSON.stringify([id, false])};
}
export function selectFaceSetup(storage, bodyId, confirmed) {
  const id = bodyName(bodyId);
  if (confirmed !== true) return refused('Confirm this is the robot you already tested with Combined.');
  if (!id) return refused('Enter this robot’s pairing code.');
  const wiring = readFaceWiring(storage);
  if (!wiring.supported) return wiring;
  try {
    storage.setItem(FACE_KEY, JSON.stringify({version:1, profile:FACE_PROFILE, bodyId:id, swap:false}));
    return readFaceSelection(storage, id);
  } catch (_) { return refused('The Face choice could not be confirmed as saved. Keep Original or try again.'); }
}
export function faceSelectionMatches(storage, expected, bodyId) {
  if (!expected || expected.source !== 'face' || !expected.supported || typeof expected.signature !== 'string') return false;
  const current = readFaceSelection(storage, bodyId);
  return current.supported && current.bodyId === expected.bodyId && current.signature === expected.signature;
}
