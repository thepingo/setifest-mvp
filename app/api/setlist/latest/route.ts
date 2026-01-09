
import { NextResponse } from "next/server";

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const mbid = searchParams.get("mbid");
    const debug = searchParams.get("debug");

    if (!mbid) {
        return NextResponse.json({ error: "Missing mbid" }, { status: 400 });
    }

    const apiKey = process.env.SETLISTFM_API_KEY;
    if (!apiKey) {
        return NextResponse.json({ error: "Missing SETLISTFM_API_KEY" }, { status: 500 });
    }

    try {
        // Fetch latest setlists
        const res = await fetch(`https://api.setlist.fm/rest/1.0/artist/${mbid}/setlists?p=1`, {
            headers: {
                "Accept": "application/json",
                "Accept-Language": "en",
                "x-api-key": apiKey
            }
        });

        if (!res.ok) {
            const upstreamBody = await res.text();
            console.log("setlist.latest", { mbid, upstreamStatus: res.status });
            if (res.status !== 200) {
                console.log("Upstream Error Body:", upstreamBody.substring(0, 200));
            }

            return NextResponse.json({
                error: "Setlist.fm error",
                upstreamStatus: res.status,
                upstreamBody: upstreamBody.substring(0, 500),
                upstreamUrl: res.url
            }, { status: 502 });
        }

        console.log("setlist.latest", { mbid, upstreamStatus: res.status });
        const data = await res.json();
        const setlists = data.setlist || [];

        // Find first setlist that yielded at least 5 song names
        let bestSetlist = null;
        let bestSongs: string[] = [];

        for (const setlist of setlists) {
            if (!setlist.sets || !setlist.sets.set) continue;

            // Flatten song names
            const songs = setlist.sets.set.flatMap((s: any) =>
                (s.song || []).map((songItem: any) => songItem.name)
            );

            if (songs.length >= 5) {
                bestSetlist = setlist;
                bestSongs = songs;
                break; // Found one
            }
        }

        // Handle "no setlists" or "no suitable setlist" as valid empty result
        if (!bestSetlist) {
            return NextResponse.json({
                artist: { name: "Unknown", mbid },
                eventDate: null,
                venue: null,
                songs: []
            });
        }

        const result = {
            artist: {
                name: bestSetlist.artist.name,
                mbid: bestSetlist.artist.mbid
            },
            eventDate: bestSetlist.eventDate,
            venue: {
                name: bestSetlist.venue?.name || "",
                city: bestSetlist.venue?.city?.name || "",
                country: bestSetlist.venue?.city?.country?.name || ""
            },
            songs: bestSongs
        };

        return NextResponse.json(result);

    } catch (error) {
        console.error("Setlist.fm Latest Setlist Error", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
