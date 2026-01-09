import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
// Scopes should be space-separated in env, e.g., "playlist-modify-public user-read-email"
const SCOPES = process.env.SPOTIFY_SCOPES || "playlist-modify-public playlist-modify-private user-read-email";

export async function GET() {
    if (!CLIENT_ID || !REDIRECT_URI) {
        console.error("Missing Spotify OAuth Configuration");
        return NextResponse.json(
            { error: "Server Configuration Error" },
            { status: 500 }
        );
    }

    const state = crypto.randomUUID();
    const searchParams = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        scope: SCOPES,
        redirect_uri: REDIRECT_URI,
        state: state,
    });

    const cookieStore = await cookies();
    cookieStore.set("spotify_oauth_state", state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 3600, // 1 hour
    });

    return NextResponse.redirect(`https://accounts.spotify.com/authorize?${searchParams.toString()}`);
}
