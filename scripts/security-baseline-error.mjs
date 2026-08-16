export class SecurityBaselineError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "SecurityBaselineError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}
