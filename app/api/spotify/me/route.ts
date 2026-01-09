import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function GET() {
    const cookieStore = await cookies();
    const accessToken = cookieStore.get("spotify_access_token")?.value;
    const expiresAt = cookieStore.get("spotify_expires_at")?.value;

    // 1. Basic Cookie Check
    if (!accessToken || !expiresAt) {
        return NextResponse.json({ connected: false });
    }

    // 2. Expiry Check
    // Note: We are not handling refresh here as per strict requirements for this task.
    // We simply report unconnected if the current access token is expired.
    if (Date.now() > Number(expiresAt)) {
        return NextResponse.json({ connected: false });
    }

    try {
        // 3. Verify with Spotify
        const response = await fetch("https://api.spotify.com/v1/me", {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });

        if (response.status === 401) {
            return NextResponse.json({ connected: false });
        }

        if (!response.ok) {
            console.error("Spotify Profile Error", await response.text());
            return NextResponse.json({ connected: false });
        }

        const data = await response.json();
        return NextResponse.json({
            connected: true,
            profile: {
                id: data.id,
                display_name: data.display_name,
            }
        });

    } catch (error) {
        console.error("Profile fetch error", error);
        return NextResponse.json({ connected: false });
    }
}
