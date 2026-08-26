import { auth } from "../../../../server/auth";
import { toNextJsHandler } from "better-auth/next-js";

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

export async function POST(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname.endsWith("/sign-up/email")) {
    return Response.json(
      { code: "INVITATION_REQUIRED", message: "Registration requires an invitation." },
      { status: 404 },
    );
  }
  return handlers.POST(request);
}
