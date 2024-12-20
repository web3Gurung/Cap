import { NextResponse, type NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const token = searchParams.get("token");
  const redirect = searchParams.get("redirect");

  if (!token) {
    return Response.json(
      { error: true, message: "Token not supplied" },
      { status: 401 }
    );
  }

  const response = NextResponse.next();
  response.cookies.set({
    name: `next-auth.session-token`,
    value: token,
    path: "/",
  });

  return NextResponse.redirect(redirect || "/");
}
