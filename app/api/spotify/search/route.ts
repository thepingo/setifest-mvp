import { NextResponse } from "next/server";
import { cache } from "@/lib/cache";

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const TTL_RESOLVE = 30 * 24 * 60 * 60 * 1000; // 30 days

// Helper for title similarity (Dice's Coefficient or similar simplified)
function getSimilarity(s1: string, s2: string): number {
    const n1 = s1.toLowerCase().replace(/[^a-z0-9]/g, "");
    const n2 = s2.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (n1 === n2) return 1.0;
    if (n1.includes(n2) || n2.includes(n1)) return 0.8;
    return 0; // Simplified for now
}

function normalize(s: string): string {
    return s.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/["'“”‘’]/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\s*\/\s*/g, ' ')
        .replace(/[+=:;!?'"&]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const artist = searchParams.get("artist");
    const track = searchParams.get("track");
    const q = searchParams.get("q");
    const limitParam = searchParams.get("limit");

    if (!artist && !q && !track) {
        return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
    }

    if (!CLIENT_ID || !CLIENT_SECRET) {
        return NextResponse.json({ error: "Server Configuration Error" }, { status: 500 });
    }

    // Parse limit
    const effectiveLimit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10), 1), 50) : (q ? 10 : 20);

    // Resolve mode logic
    const isResolveMode = !!(artist && track && !q);
    const cacheKey = isResolveMode
        ? `spotify:resolve:${normalize(artist)}:${normalize(track)}`
        : `spotify:search:${q || artist || track}:${effectiveLimit}`;

    try {
        const cached = await cache.get(cacheKey);
        if (cached) {
            return NextResponse.json(cached.value, {
                headers: { "x-cache": "HIT", "x-cache-source": cached.source }
            });
        }

        const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
            },
            body: "grant_type=client_credentials",
            cache: "no-store",
        });

        if (!tokenResponse.ok) return NextResponse.json({ error: "Auth fail" }, { status: 500 });
        const { access_token: accessToken } = await tokenResponse.json();

        const fetchSpotify = async (url: string) => {
            const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
            return res.ok ? res.json() : null;
        };

        let finalResult: any = null;

        if (isResolveMode) {
            const trackClean = normalize(track!);
            const artistClean = normalize(artist!);

            // PHASE 1: Strict
            const strictUrl = `https://api.spotify.com/v1/search?q=track:${encodeURIComponent(trackClean)}%20artist:${encodeURIComponent(artistClean)}&type=track&limit=5`;
            const strictData = await fetchSpotify(strictUrl);
            const strictTracks = strictData?.tracks?.items || [];

            const bestStrict = strictTracks.find((t: any) =>
                t.artists.some((a: any) => normalize(a.name) === artistClean)
            );

            if (bestStrict) {
                finalResult = {
                    artist: bestStrict.artists[0]?.name,
                    title: bestStrict.name,
                    id: bestStrict.id,
                    uri: bestStrict.uri,
                    url: bestStrict.external_urls?.spotify,
                    durationMs: bestStrict.duration_ms,
                    matchMode: "strict",
                    confidence: 1.0,
                    resolvedArtistName: bestStrict.artists[0]?.name
                };
            } else {
                // PHASE 2: Fallback
                const fallbackUrl = `https://api.spotify.com/v1/search?q=track:${encodeURIComponent(trackClean)}&type=track&limit=10`;
                const fallbackData = await fetchSpotify(fallbackUrl);
                const fallbackTracks = fallbackData?.tracks?.items || [];

                const scored = fallbackTracks.map((t: any) => {
                    let score = getSimilarity(t.name, trackClean);

                    const noise = ["karaoke", "tribute", "instrumental", "remix", "cover"];
                    const lowName = t.name.toLowerCase();
                    if (noise.some(n => lowName.includes(n))) score -= 0.4;

                    score += (t.popularity / 100) * 0.1;
                    return { ...t, score };
                }).sort((a: any, b: any) => b.score - a.score);

                const bestFallback = scored[0];
                if (bestFallback && bestFallback.score > 0.5) {
                    finalResult = {
                        artist: bestFallback.artists[0]?.name,
                        title: bestFallback.name,
                        id: bestFallback.id,
                        uri: bestFallback.uri,
                        url: bestFallback.external_urls?.spotify,
                        durationMs: bestFallback.duration_ms,
                        matchMode: "fallback",
                        confidence: bestFallback.score,
                        resolvedArtistName: bestFallback.artists[0]?.name
                    };
                }
            }
        } else {
            // Legacy search
            const searchUrl = q
                ? `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=${effectiveLimit}`
                : `https://api.spotify.com/v1/search?q=artist:${encodeURIComponent(`"${artist}"`)}&type=track&limit=${effectiveLimit}`;

            const data = await fetchSpotify(searchUrl);
            const items = data?.tracks?.items || [];
            finalResult = items.map((t: any) => ({
                artist: t.artists[0]?.name,
                title: t.name,
                id: t.id,
                uri: t.uri,
                url: t.external_urls?.spotify,
                durationMs: t.duration_ms
            }));
        }

        if (finalResult) {
            await cache.set(cacheKey, finalResult, TTL_RESOLVE);
        }

        return NextResponse.json(finalResult, {
            headers: { "x-cache": "MISS", "x-cache-source": "live" }
        });

    } catch (e) {
        return NextResponse.json({ error: "Internal Error" }, { status: 500 });
    }
}
