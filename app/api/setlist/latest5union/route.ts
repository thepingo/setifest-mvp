import { NextResponse } from "next/server";
import { cache } from "@/lib/cache";

const TTL_UNION = 24 * 60 * 60 * 1000; // 24 hours

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const mbid = searchParams.get("mbid");
    const limitParam = searchParams.get("limit");

    if (!mbid) {
        return NextResponse.json({ error: "Missing mbid" }, { status: 400 });
    }

    let limit = 5;
    if (limitParam) {
        const parsed = parseInt(limitParam, 10);
        if (!isNaN(parsed)) {
            limit = Math.min(Math.max(parsed, 1), 5);
        }
    }

    const cacheKey = `setlist:union:${mbid}:${limit}`;

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

        const validSetlists: any[] = [];
        let page = 1;
        const maxPages = 5; // Safety limit to avoid infinite loops
        let setlistsScanned = 0;
        let skippedEmpty = 0;
        let skippedOld = 0;

        while (validSetlists.length < limit && page <= maxPages) {
            const res = await fetch(`https://api.setlist.fm/rest/1.0/artist/${mbid}/setlists?p=${page}`, {
                headers: {
                    "Accept": "application/json",
                    "Accept-Language": "en",
                    "x-api-key": apiKey
                }
            });

            if (!res.ok) {
                // If specific page fails, log and break loop to work with what we have
                console.warn(`Setlist.fm error on page ${page}:`, res.status);
                break;
            }

            const data = await res.json();
            const pageSetlists = data.setlist || [];

            if (pageSetlists.length === 0) break;

            for (const setlist of pageSetlists) {
                setlistsScanned++;

                // Check if setlist has actual songs
                let hasSongs = false;
                if (setlist.sets && setlist.sets.set && Array.isArray(setlist.sets.set)) {
                    hasSongs = setlist.sets.set.some((s: any) =>
                        s.song && Array.isArray(s.song) && s.song.length > 0
                    );
                }

                if (hasSongs) {
                    // Date Filter: Current or Previous Year
                    const parts = setlist.eventDate?.split("-");
                    if (parts && parts.length === 3) {
                        const year = parseInt(parts[2], 10);
                        const currentYear = new Date().getFullYear();
                        if (year === currentYear || year === currentYear - 1) {
                            validSetlists.push(setlist);
                        } else {
                            skippedOld++;
                        }
                    } else {
                        // Invalid date format count as old/skipped
                        skippedOld++;
                    }
                } else {
                    skippedEmpty++;
                }

                if (validSetlists.length >= limit) break;
            }

            // Pagination check
            const total = data.total || 0;
            const itemsPerPage = data.itemsPerPage || 20;
            if (page * itemsPerPage >= total) break;

            page++;
        }

        const usedSetlists = validSetlists;

        if (usedSetlists.length === 0) {
            const emptyResult = {
                artist: { name: "Unknown", mbid },
                sources: [],
                songs: [],
                stats: {
                    setlistsUsed: 0,
                    totalUnionSongs: 0,
                    setlistsScanned,
                    skippedEmpty,
                    skippedOld
                }
            };
            return NextResponse.json({
                ...emptyResult,
                cached: false,
                cacheKey,
                cacheSource: "live"
            });
        }

        const IGNORE_SONGS = new Set(["intro", "outro", "interlude", "tape", "unknown"]);

        const normalize = (name: string) => {
            return name
                .replace(/\([^)]*\)/g, "") // remove text in parentheses
                .replace(/\//g, " ")      // replace "/" with space
                .replace(/\s+/g, " ")     // collapse multiple spaces
                .trim();
        };

        const getDedupeKey = (name: string) => {
            return normalize(name).toLowerCase();
        };

        const seenKeys = new Set<string>();
        const unionSongs: string[] = [];
        const sources: any[] = [];

        for (const setlist of usedSetlists) {
            let setlistSongCount = 0;
            const rawSongs: string[] = [];

            if (setlist.sets && setlist.sets.set) {
                setlist.sets.set.forEach((s: any) => {
                    (s.song || []).forEach((songItem: any) => {
                        if (songItem.name) {
                            rawSongs.push(songItem.name);
                        }
                    });
                });
            }

            for (const songName of rawSongs) {
                const key = getDedupeKey(songName);
                if (!key || IGNORE_SONGS.has(key)) continue;

                setlistSongCount++;

                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    unionSongs.push(normalize(songName));
                }
            }

            sources.push({
                id: setlist.id,
                eventDate: setlist.eventDate,
                venue: {
                    name: setlist.venue?.name || "",
                    city: setlist.venue?.city?.name || "",
                    country: setlist.venue?.city?.country?.name || ""
                },
                songCount: setlistSongCount
            });
        }

        const firstSetlist = usedSetlists[0];

        const finalResult = {
            artist: {
                name: firstSetlist.artist.name,
                mbid: firstSetlist.artist.mbid
            },
            sources,
            songs: unionSongs,
            stats: {
                setlistsUsed: sources.length,
                totalUnionSongs: unionSongs.length,
                setlistsScanned,
                skippedEmpty,
                skippedOld
            }
        };

        // 2. Set Cache
        await cache.set(cacheKey, finalResult, TTL_UNION);

        return NextResponse.json({
            ...finalResult,
            cached: false,
            cacheKey,
            cacheSource: "live"
        }, {
            headers: {
                "x-cache": "HIT",
                "x-cache-source": "live"
            }
        });

    } catch (error) {
        console.error("Setlist.fm Union Error", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
