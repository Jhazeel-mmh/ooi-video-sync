import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only: the real authorization happens in `requireAdmin()`.
export function proxy(request: NextRequest) {
  if (!request.cookies.has("ovs_session")) {
    const url = new URL("/login", request.url);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico).*)"],
};
