export const ACCOUNT_PASSWORD_MIN_LENGTH = 12;

export function accountPasswordError(password: string, confirmation: string): string | null {
  if (password.length < ACCOUNT_PASSWORD_MIN_LENGTH) {
    return `Use at least ${ACCOUNT_PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Include an uppercase letter, a lowercase letter and a number.';
  }
  if (password !== confirmation) return 'The passwords do not match.';
  return null;
}
