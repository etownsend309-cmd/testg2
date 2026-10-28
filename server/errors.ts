/**
 * Errors the API turns into HTTP responses.
 *
 * Services throw `ApiError` for anything the caller did wrong. Postgres errors
 * raised by policies, triggers and constraints are translated here so the
 * database stays the final authority without leaking SQL to the browser.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string) => new ApiError(400, message);
export const unauthorized = () => new ApiError(401, "Sign in to continue.");
export const forbidden = (message = "You don't have permission to do that.") => new ApiError(403, message);
export const notFound = (what = "That item") => new ApiError(404, `${what} was not found.`);
export const conflict = (message: string) => new ApiError(409, message);

interface PgError {
  code?: string;
  message?: string;
}

/** Messages written for people by our own triggers (RAISE EXCEPTION); safe to pass through. */
const OWN_TRIGGER_MESSAGE = /^(Approving an agreement|The submitter of an agreement|The Approver permission)/;

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  const pg = error as PgError;
  const message = typeof pg?.message === "string" ? pg.message : "";
  const friendly = OWN_TRIGGER_MESSAGE.test(message) ? message : undefined;

  switch (pg?.code) {
    case "42501": // insufficient_privilege, including "violates row-level security policy"
      return forbidden(friendly);
    case "23514": // check_violation
      return badRequest(friendly ?? "Some of the values aren't allowed.");
    case "23505": // unique_violation
      return conflict("That already exists.");
    case "23503": // foreign_key_violation
      return badRequest("That refers to something that doesn't exist.");
    case "22P02": // invalid_text_representation (bad uuid, bad enum)
    case "22007": // invalid_datetime_format
    case "22008": // datetime_field_overflow
      return badRequest("Some of the values are in the wrong format.");
    default:
      return new ApiError(500, "Something went wrong on our side. Try again in a moment.");
  }
}
