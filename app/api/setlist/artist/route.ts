import { NextResponse } from "next/server";
import { cache } from "@/lib/cache";

const TTL_ARTIST = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const name = searchParams.get("name");

    if (!name) {
        return NextResponse.json({ error: "Missing name" }, { status: 400 });
    }

    const normalize = (s: string) => s.toLowerCase().trim();
    const cacheKey = `setlist:artist:${normalize(name)}`;

    try {
        // 1. Check Cache
        const cached = await cache.get(cacheKey);
        if (cached) {
            return NextResponse.json({
                ...cached.value,
                cached: true,
                cacheKey,
                cacheSource: cached.source
            }, {
                headers: {
                    "x-cache": "HIT",
                    "x-cache-source": cached.source
                }
            });
        }

        const apiKey = process.env.SETLISTFM_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: "Missing SETLISTFM_API_KEY" }, { status: 500 });
        }

        const res = await fetch(`https://api.setlist.fm/rest/1.0/search/artists?artistName=${encodeURIComponent(name)}&p=1&sort=relevance`, {
            headers: {
                "Accept": "application/json",
                "x-api-key": apiKey
            }
        });

        if (!res.ok) {
            return NextResponse.json({ error: "Setlist.fm error" }, { status: res.status });
        }

        const data = await res.json();

        // Normalize artist response: can be missing, object, or array
        let artists = [];
        if (data.artist) {
            artists = Array.isArray(data.artist) ? data.artist : [data.artist];
        }

        const rawResults = artists
            .filter((a: any) => a.mbid)
            .map((a: any) => ({
                name: a.name,
                mbid: a.mbid
            }));

        const normName = normalize(name);

        // Find best match: exact match OR shortest name from results
        let best = null;
        let exactMatch = rawResults.find((r: { name: string; mbid: string }) => normalize(r.name) === normName);

        if (exactMatch) {
            best = { name: exactMatch.name, mbid: exactMatch.mbid };
        } else if (rawResults.length > 0) {
            // Sort by name length to find the most likely match (shorter usually better for raw queries)
            const sortedByLength = [...rawResults].sort((a, b) => a.name.length - b.name.length);
            best = { name: sortedByLength[0].name, mbid: sortedByLength[0].mbid };
        }

        // needsChoice: true if > 1 result and no exact match
        const needsChoice = rawResults.length > 1 && !exactMatch;

        const finalResult = {
            best,
            needsChoice,
            results: rawResults.slice(0, 10)
        };

        // 2. Set Cache
        await cache.set(cacheKey, finalResult, TTL_ARTIST);

        return NextResponse.json({
            ...finalResult,
            cached: false,
            cacheKey,
            cacheSource: "live"
        }, {
            headers: {
                "x-cache": "MISS",
                "x-cache-source": "live"
            }
        });

    } catch (error) {
        console.error("Setlist.fm Artist Search Error", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
