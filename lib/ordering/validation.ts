import { AccountError } from "../accounts";
export function fail(message: string, status = 400): never {
  throw new AccountError(status, message);
}
export function text(value: unknown, label: string, max = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    return fail(`Enter ${label} (up to ${max} characters).`);
  return value.trim();
}
export function id(value: unknown) {
  if (typeof value !== "string" || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value))
    return fail("Choose a valid record.");
  return value;
}
export function integer(value: unknown, min = 0, max = 1000000) {
  const n = Number(value);
  if (value === "" || !Number.isSafeInteger(n) || n < min || n > max)
    return fail(`Enter a whole number between ${min} and ${max}.`);
  return n;
}
