import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const APP_URL = process.env.APP_URL || "http://localhost:3000";

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const error = searchParams.get("error");

    const cookieStore = await cookies();
    const storedState = cookieStore.get("spotify_oauth_state")?.value;

    // 1. Validate State
    if (!storedState && process.env.NODE_ENV === "development") {
        console.warn("OAuth state cookie missing in development, skipping validation");
    } else if (!state || state !== storedState) {
        return NextResponse.json({ error: "State mismatch" }, { status: 400 });
    }

    // 2. Handle Errors
    if (error) {
        return NextResponse.json({ error: error }, { status: 400 });
    }

    if (!code) {
        return NextResponse.json({ error: "Missing code" }, { status: 400 });
    }

    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
        return NextResponse.json({ error: "Server Configuration Error" }, { status: 500 });
    }

    try {
        // 3. Exchange Code for Tokens
        const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization:
                    "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
            },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
        });

        if (!tokenResponse.ok) {
            const errText = await tokenResponse.text();
            console.error("Token Exchange Failed", errText);
            return NextResponse.json({ error: "Failed to exchange token" }, { status: 500 });
        }

        const tokenData = await tokenResponse.json();
        const { access_token, refresh_token, expires_in } = tokenData;

        // 4. Store Tokens in Cookies
        const isProduction = process.env.NODE_ENV === "production";
        const cookieOptions = {
            httpOnly: true,
            secure: isProduction,
            sameSite: "lax" as const,
            path: "/",
        };

        cookieStore.set("spotify_access_token", access_token, {
            ...cookieOptions,
            maxAge: expires_in,
        });

        if (refresh_token) {
            cookieStore.set("spotify_refresh_token", refresh_token, {
                ...cookieOptions,
                maxAge: 30 * 24 * 60 * 60, // 30 days roughly
            });
        }

        // Store raw expiry timestamp for client-side checks/middleware if needed
        cookieStore.set("spotify_expires_at", (Date.now() + expires_in * 1000).toString(), {
            ...cookieOptions,
            maxAge: expires_in,
        });

        // 5. Clean Up State
        cookieStore.delete("spotify_oauth_state");

        // 6. Redirect to App
        return NextResponse.redirect(`${APP_URL}?connected=1`);

    } catch (err) {
        console.error("Callback Error", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
