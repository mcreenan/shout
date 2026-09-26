export function validateSignup(name) {
  return /^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(name.trim());
}

export function validateProfile(name) {
  return name.length > 0;
}
