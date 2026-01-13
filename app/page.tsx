"use client";

import { useState, useEffect, useMemo } from "react";
import { createWorker } from "tesseract.js";

type SpotifyTrack = {
  artist: string;
  title: string;
  id?: string;
  uri?: string;
  url: string;
  durationMs: number;
  source?: string;
};

type ArtistPlaylist = {
  artist: string;
  tracks: SpotifyTrack[];
  error?: string;
  originalSongCount: number;
  setlistUrl?: string;
  metadata?: {
    eventDate?: string;
    venue?: string;
    city?: string;
  };
  debugStats?: any;
};

// Keep history typed slightly loosely for now or match specific fields
// We update this type to avoid TS errors when saving the new playlist data
type PlaylistDraft = {
  id: string;
  createdAt: number;
  artists: string[];
  artistMetadata?: Record<string, { eventDate?: string; venue?: string; city?: string }>;
  tracks: { artist: string; title: string; url?: string; durationMs?: number }[];
  playlistUrl?: string;
  playlistName?: string;
};

export default function Home() {
  const [inputText, setInputText] = useState("");
  const [artistChips, setArtistChips] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [playlist, setPlaylist] = useState<ArtistPlaylist[]>([]);
  const [history, setHistory] = useState<PlaylistDraft[]>([]);

  /* New State for Playlist Creation */
  const [isConnected, setIsConnected] = useState(false);
  const [userProfile, setUserProfile] = useState<{ display_name: string } | null>(null);
  const [isCreatingPlaylist, setIsCreatingPlaylist] = useState(false);
  const [createdPlaylistUrl, setCreatedPlaylistUrl] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);

  /* Naming Modal State */
  const [showNameModal, setShowNameModal] = useState(false);
  const [customPlaylistName, setCustomPlaylistName] = useState("");

  /* Poster Upload State */
  const [posterFile, setPosterFile] = useState<File | null>(null);
  const [posterPreviewUrl, setPosterPreviewUrl] = useState<string | null>(null);
  const [generationStatus, setGenerationStatus] = useState<"idle" | "fetching" | "resolving" | "success" | "partial" | "error">("idle");
  const [debugEnabled, setDebugEnabled] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      setDebugEnabled(params.get("debug") === "1");
    }
  }, []);

  const [ocrCandidates, setOcrCandidates] = useState<{ id: string; text: string; selected: boolean }[]>([]);
  const [editingCandidateId, setEditingCandidateId] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState("");
  const [isOcrLoading, setIsOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [showRawOcr, setShowRawOcr] = useState(false);

  /* Setlist Progress State */
  const [setlistProgress, setSetlistProgress] = useState("");
  const [setlistStats, setSetlistStats] = useState<{
    total: number;
    matched: number;
    missing: number;
    missingSetlists?: string[];
    fallbackUsed?: boolean;
    debugInfo?: any[];
  } | null>(null);
  const [missingTracks, setMissingTracks] = useState<{ artist: string; song: string }[]>([]);
  const [isRetrying, setIsRetrying] = useState(false);
  const [showMissingPanel, setShowMissingPanel] = useState(false);

  /* Computed State for Missing Tracks */
  const groupedMissing = useMemo(() => {
    const groups: Record<string, string[]> = {};
    missingTracks.forEach(t => {
      if (!groups[t.artist]) groups[t.artist] = [];
      groups[t.artist].push(t.song);
    });
    return groups;
  }, [missingTracks]);

  const handleCopyMissing = () => {
    const text = Object.entries(groupedMissing)
      .map(([artist, songs]) => `${artist}:\n${songs.map(s => `- ${s}`).join("\n")}`)
      .join("\n\n");
    navigator.clipboard.writeText(text);
  };

  /* Poster Handlers */
  const handleFileSelect = (file: File) => {
    if (!file.type.startsWith("image/")) return;

    setPosterFile(file);
    const url = URL.createObjectURL(file);
    setPosterPreviewUrl(url);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const removePoster = () => {
    setPosterFile(null);
    if (posterPreviewUrl) URL.revokeObjectURL(posterPreviewUrl);
    setPosterPreviewUrl(null);
    setOcrText("");
    setOcrCandidates([]);
    setOcrError(null);
  };

  const extractArtistsFromPoster = async () => {
    if (!posterFile || isOcrLoading) return;

    setIsOcrLoading(true);
    setOcrError(null);
    setOcrText("");

    try {
      // 1. Preprocess Image (Client-side Resize)
      const imageBitmap = await createImageBitmap(posterFile);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) throw new Error("Canvas context failed");

      // Resize logic (max width 1400, maintain aspect ratio)
      const MAX_WIDTH = 1400;
      let width = imageBitmap.width;
      let height = imageBitmap.height;

      if (width > MAX_WIDTH) {
        height = Math.round((height * MAX_WIDTH) / width);
        width = MAX_WIDTH;
      }

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(imageBitmap, 0, 0, width, height);

      // Convert to blob
      const blob = await new Promise<Blob | null>(resolve =>
        canvas.toBlob(resolve, 'image/png')
      );

      if (!blob) throw new Error("Image processing failed");

      // 2. Initialize Tesseract Worker
      const worker = await createWorker('eng');

      // 3. Recognize
      const result = await worker.recognize(blob);
      const text = result.data.text || "";

      // 4. Cleanup
      await worker.terminate();

      setOcrText(text);

      // 5. Initial Parsing Logic (MVP Heuristic)
      const lines = text.split("\n")
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0);

      const blockedWords = ["presenta", "tickets", "festival", "stage", "día", "abonos", "entradas", "sponsor", "www", "http", "lineup", "cartel", "tickets"];

      const candidates = lines.map(line => {
        const low = line.toLowerCase();
        // Simple noise filter for initial list, but verify everything
        if (blockedWords.some(word => low.includes(word))) return null;
        if (line.length < 2) return null; // Too short

        return {
          id: crypto.randomUUID(),
          text: line,
          selected: true
        };
      }).filter(Boolean) as { id: string; text: string; selected: boolean }[];

      setOcrCandidates(candidates);

    } catch (e) {
      console.error("OCR Failed", e);
      setOcrError("Falló la lectura del cartel (Client). Intenta con otra imagen.");
    } finally {
      setIsOcrLoading(false);
    }
  };

  /* Review handlers */
  const handleSelectAll = () => {
    setOcrCandidates(prev => prev.map(c => ({ ...c, selected: true })));
  };

  const handleDeselectAll = () => {
    setOcrCandidates(prev => prev.map(c => ({ ...c, selected: false })));
  };

  /* Advanced Helper: Parse Candidates from Text */
  const extractCandidatesFromText = (text: string): { id: string; text: string; selected: boolean }[] => {
    const STOPLIST = [
      "festival", "fest", "live", "presenta", "presentan", "tickets", "ticket", "entradas", "abonos", "info",
      "estadio", "recinto", "gran canaria", "canaria", "julio", "junio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
      "viernes", "sabado", "sábado", "domingo", "lunes", "martes", "miercoles", "miércoles", "jueves",
      "stage", "main stage", "sponsor", "patrocina", "colabora",
      "www", "http", "https", ".es", ".com", "@", "line up", "lineup"
    ];

    // 1. Initial Split & Cleanup
    const rawLines = text.split("\n")
      .map(l => l.trim().replace(/\s+/g, " "))
      .filter(l => l.length > 0);

    const parsedItems: { text: string; score: number }[] = [];

    rawLines.forEach(line => {
      // Splitting by separators if line is short enough
      let segments = [line];
      if (line.length <= 45 && (line.includes("/") || line.includes(" • ") || line.includes(" | "))) {
        segments = line.split(/[\/|•]/).map(s => s.trim());
      }

      segments.forEach(segment => {
        // Basic cleanup
        let clean = segment.replace(/^[\p{P}]+|[\p{P}]+$/gu, "").trim(); // Remove leading/trailing punctuation

        // DISCARD RULES
        if (clean.length < 3 || clean.length > 45) return;

        // 25% digits check
        const digitCount = (clean.match(/\d/g) || []).length;
        if (digitCount / clean.length > 0.25) return;

        // Mostly punctuation check
        const punctCount = (clean.match(/[\p{P}]/gu) || []).length;
        if (punctCount / clean.length > 0.5) return;

        // Colon check (unless artistic like "AC/DC") -> Actually "AC/DC" has slash. Colon usually means "Time: 20:00"
        // Heuristic: Allow colon if ALL CAPS and short? 
        // User rule: Discard if contains ":" unless looks like artist (ALL CAPS <= 35)
        if (clean.includes(":")) {
          const isAllCaps = clean === clean.toUpperCase();
          if (!isAllCaps || clean.length > 35) return;
        }

        // URL/Email check
        if (clean.includes("http") || clean.includes("www") || clean.includes(".com") || clean.includes("@")) return;

        // STOPLIST check (Whole word or obvious substring)
        const lower = clean.toLowerCase();
        const hasStopWord = STOPLIST.some(stop => {
          // Whole word check regex
          const regex = new RegExp(`\\b${stop}\\b`, 'i');
          return regex.test(clean) || (stop.length > 4 && lower.includes(stop)); // Simple substring for longer stop words
        });

        // SCORING
        let score = 0;

        if (hasStopWord) score -= 2;

        // Date/Event words penalty
        if (/\b(202\d|vip|general|early|bird)\b/i.test(clean)) score -= 1;

        // All CAPS bonus
        const words = clean.split(" ");
        const allCapsCount = words.filter(w => w.length > 1 && w === w.toUpperCase()).length;

        if (allCapsCount >= 2) score += 2;
        else if (words.length === 1 && clean === clean.toUpperCase() && clean.length >= 4 && clean.length <= 18) score += 1;

        // Accents/Special chars bonus
        if (/[ÁÉÍÓÚÜÑáéíóúüñ’&-]/.test(clean) && clean.length > 3) score += 1;

        // Bonus for pure text (no digits) to be generous for simple names
        if (!/\d/.test(clean)) score += 1;

        if (score >= 2) {
          parsedItems.push({ text: clean, score });
        }
      });
    });

    // DEDUP (Case insensitive, prefer higher score or All Caps)
    const uniqueMap = new Map<string, { text: string; score: number }>();

    parsedItems.forEach(item => {
      const key = item.text.toLowerCase();
      const existing = uniqueMap.get(key);
      if (!existing || item.score > existing.score) {
        uniqueMap.set(key, item);
      } else if (item.score === existing.score) {
        // Prefer original casing with more capitals?
        if (item.text !== existing.text && item.text === item.text.toUpperCase()) {
          uniqueMap.set(key, item);
        }
      }
    });

    return Array.from(uniqueMap.values()).map(item => ({
      id: crypto.randomUUID(),
      text: item.text,
      selected: true
    }));
  };

  const handleCleanNoise = () => {
    // Re-run advanced filtering on the raw OCR text if available, 
    // otherwise strictly filter existing candidates.
    if (ocrText) {
      setOcrCandidates(extractCandidatesFromText(ocrText));
    } else {
      setOcrCandidates(prev => prev.filter(c => c.text.length > 2));
    }
  };

  const handleAddSelected = () => {
    const selected = ocrCandidates
      .filter(c => c.selected && c.text.trim().length > 0)
      .map(c => c.text.trim());

    if (selected.length === 0) return;

    const uniqueArtists = Array.from(new Set([...artistChips, ...selected]));
    setArtistChips(uniqueArtists);

    // Clear OCR state after adding
    setOcrCandidates([]);
    setOcrText("");
    // Let's clear candidates so the review UI disappears.
  };

  const handleAddAllAndContinue = () => {
    // 1. Select all candidates first (implicitly)
    const allCandidates = ocrCandidates
      .filter(c => c.text.trim().length > 0)
      .map(c => c.text.trim());

    if (allCandidates.length === 0) return;

    // 2. Add to chips
    const uniqueArtists = Array.from(new Set([...artistChips, ...allCandidates]));
    setArtistChips(uniqueArtists);

    // 3. Close OCR
    setOcrCandidates([]);
    setOcrText("");

    // 4. Scroll to Generate Section
    // Use setTimeout to allow render cycle to complete if needed, though mostly synchronous here
    setTimeout(() => {
      const genBtn = document.getElementById("generate-playlist-btn");
      if (genBtn) {
        genBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 100);
  };

  const toggleCandidate = (id: string) => {
    setOcrCandidates(prev => prev.map(c => c.id === id ? { ...c, selected: !c.selected } : c));
  };

  const updateCandidateText = (id: string, newText: string) => {
    setOcrCandidates(prev => prev.map(c => c.id === id ? { ...c, text: newText } : c));
  };

  // Load history & Auth status on mount
  useEffect(() => {
    // 1. History
    try {
      const stored = localStorage.getItem("setifest_history");
      if (stored) {
        setHistory(JSON.parse(stored));
      }
    } catch (e) {
      console.error("Failed to parse history", e);
    }

    // 2. Initial Auth Check
    const checkAuth = () => {
      fetch("/api/spotify/me")
        .then(res => res.json())
        .then(data => {
          if (data.connected) {
            setIsConnected(true);
            setUserProfile(data.profile);
          }
        })
        .catch(err => console.error("Auth Check Error", err));
    };

    checkAuth();

    // 3. Handle OAuth callback query param
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected")) {
      // Remove param from URL without reload
      const newUrl = window.location.pathname;
      window.history.replaceState({}, "", newUrl);

      // Wait a tick for cookies to settle (dev mode/latency) then re-check
      setTimeout(() => {
        checkAuth();
      }, 500);
    }
  }, []);

  const handleLogout = async () => {
    try {
      await fetch("/api/spotify/logout", { method: "POST" });
      setIsConnected(false);
      setUserProfile(null);
    } catch (e) {
      console.error("Logout failed", e);
    }
  };

  /* Helper to generate smart playlist name */
  const getSmartPlaylistName = (artists: string[]) => {
    const firstTwo = artists.slice(0, 2).join(", ");
    const remainingCount = artists.length - 2;
    const topArtists = remainingCount > 0 ? `${firstTwo} +${remainingCount}` : firstTwo;
    const dateStr = new Date().toLocaleDateString();
    return `SetiFest - ${topArtists} (${dateStr})`;
  };

  /* Computed State for Strict Creation Logic - Source of Truth: generationStatus & setlistStats */
  const allTrackUris = playlist.flatMap(group => group.tracks.map(t => t.uri)).filter(Boolean);
  const foundTracksCount = setlistStats?.matched || allTrackUris.length;
  const canCreatePlaylist = isConnected && foundTracksCount > 0 && !createdPlaylistUrl && !isCreatingPlaylist;

  /* Reset createdPlaylistUrl when tracks change */
  const tracksKey = allTrackUris.join("|");
  useEffect(() => {
    if (createdPlaylistUrl) {
      setCreatedPlaylistUrl(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracksKey]);

  /* Helper to convert Draft -> PlaylistArtist[] */
  const convertDraftToPlaylist = (draft: PlaylistDraft): ArtistPlaylist[] => {
    const grouped: ArtistPlaylist[] = [];
    draft.tracks.forEach(t => {
      let group = grouped.find(g => g.artist === t.artist);
      if (!group) {
        group = {
          artist: t.artist,
          tracks: [],
          originalSongCount: (draft as any).stats?.totalSetlist || 0, // Fallback to total if per-artist count unavailable
          metadata: draft.artistMetadata ? draft.artistMetadata[t.artist] : undefined
        };
        grouped.push(group);
      }
      group.tracks.push({
        artist: t.artist,
        title: t.title,
        url: t.url || "",
        durationMs: t.durationMs || 0
      });
    });

    // If we have stats, we can try to refine originalSongCount if it was distributed evenly (imperfect but better than 0)
    // Actually, in the history we don't store per-artist original counts yet, so 0 or total/numArtists is the best we can do.
    // For now, let's just ensure it's not breaking the UI.
    return grouped;
  };

  /* New handler to open modal */
  const handleMainCreateClick = () => {
    const defaultName = getSmartPlaylistName(artistChips);
    setCustomPlaylistName(defaultName);
    setShowNameModal(true);
  };

  const createSpotifyPlaylist = async (playlistOverride?: ArtistPlaylist[], draftIdOverride?: string, nameOverride?: string) => {
    // Strict Guard:
    // If we rely on main state (no override), we strictly check canCreatePlaylist.
    // If we have an override (history), we manually check conditions because 'canCreatePlaylist' 
    // might be stale due to async state updates from loadDraft.
    if (!playlistOverride) {
      if (!canCreatePlaylist) return;
    } else {
      // For overrides, we just ensure we are connected and not currently creating/don't have a URL set *globally* yet (though typically loading a draft clears it).
      if (!isConnected || isCreatingPlaylist || createdPlaylistUrl) return;
    }

    setCreateError(null);
    setCreatedPlaylistUrl(null);
    setIsCreatingPlaylist(true);
    setIsLoading(true);

    try {
      // Use override or current state
      const targetPlaylist = playlistOverride || playlist;

      // Flatten all tracks and prefer URIs
      const rawTracks = targetPlaylist.flatMap(group => group.tracks);

      // Deduplicate by Spotify ID and collect URIs
      const seenIds = new Set<string>();
      const trackUris: string[] = [];

      rawTracks.forEach(track => {
        // Prefer URI if available, otherwise convert URL to URI
        let uri = track.uri;
        let id = track.id;

        if (!uri && track.url) {
          // Extract ID from URL and create URI
          const match = track.url.match(/track\/([a-zA-Z0-9]+)/);
          if (match && match[1]) {
            id = match[1];
            uri = `spotify:track:${id}`;
          }
        }

        if (uri && id && !seenIds.has(id)) {
          seenIds.add(id);
          trackUris.push(uri);
        }
      });

      const duplicateCount = rawTracks.length - trackUris.length;
      if (duplicateCount > 0) {
        console.log(`Skipped ${duplicateCount} duplicate/invalid tracks.`);
      }

      if (trackUris.length === 0) {
        setCreateError("No valid tracks to add.");
        setIsCreatingPlaylist(false);
        setIsLoading(false);
        return;
      }

      // Generate dynamic name (use override, or generate from specific artists if passed, or default to current chips)
      // If nameOverride is passed (from modal), use it.
      // If not (e.g. from history direct click?), generate smart name from the playlist's artists.
      const artistsForName = playlistOverride
        ? playlistOverride.map(g => g.artist)
        : artistChips;

      const playlistName = nameOverride || getSmartPlaylistName(artistsForName);

      const res = await fetch("/api/spotify/create-playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: playlistName,
          description: "Generated from Setifest MVP",
          isPublic: false,
          trackUrls: trackUris
        })
      });

      if (res.status === 401) {
        setCreateError("Conecta Spotify primero");
        setIsConnected(false); // Assume disconnected
        return;
      }

      if (!res.ok) throw new Error("API Error");

      const data = await res.json();
      setCreatedPlaylistUrl(data.playlistUrl);

      // Save URL to history item (override or current)
      const targetDraftId = draftIdOverride || currentDraftId;
      if (targetDraftId && data.playlistUrl) {
        setHistory(prev => {
          const updated = prev.map(item =>
            item.id === targetDraftId ? { ...item, playlistUrl: data.playlistUrl, playlistName: playlistName } : item
          );
          try {
            localStorage.setItem("setifest_history", JSON.stringify(updated));
          } catch (e) { /* ignore */ }
          return updated;
        });
      }

      // Cleanup if main flow (no override)
      if (!playlistOverride) {
        setInputText("");
        setArtistChips([]);
      }

    } catch (e) {
      console.error("Creation Error", e);
      setCreateError("No se pudo crear la playlist");
    } finally {
      setIsCreatingPlaylist(false);
      setIsLoading(false);
    }
  };

  const handleAddArtists = () => {
    if (!inputText.trim()) return;

    const newArtists = inputText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const uniqueArtists = Array.from(new Set([...artistChips, ...newArtists]));

    setArtistChips(uniqueArtists);
    setInputText("");
  };

  const resetSetlistGeneration = () => {
    setPlaylist([]);
    setGenerationStatus("idle");
    setSetlistStats(null);
    setMissingTracks([]);
    setIsRetrying(false);
    setCreatedPlaylistUrl(null);
    setSetlistProgress("");
    setShowMissingPanel(false);
  };

  const removeArtist = (artistToRemove: string) => {
    const updated = artistChips.filter((artist) => artist !== artistToRemove);
    setArtistChips(updated);
    if (updated.length === 0) {
      resetSetlistGeneration();
    }
  };

  const formatDuration = (ms: number) => {
    if (!ms) return "--:--";
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;
  };

  const generatePlaylist = async () => {
    if (artistChips.length === 0) return;

    setIsLoading(true);
    setPlaylist([]);

    try {
      const promises = artistChips.map(async (artist) => {
        try {
          const res = await fetch(`/api/spotify/search?artist=${encodeURIComponent(artist)}`);
          if (!res.ok) {
            return { artist, tracks: [], error: "No se pudo cargar info", originalSongCount: 0 };
          }
          const tracks: SpotifyTrack[] = await res.json();
          return { artist, tracks, originalSongCount: tracks.length };
        } catch (err) {
          return { artist, tracks: [], error: "Error de conexión", originalSongCount: 0 };
        }
      });

      const newPlaylist = await Promise.all(promises);
      setPlaylist(newPlaylist);

      addToHistory(newPlaylist, artistChips);

    } catch (e) {
      console.error("Critical error generating playlist", e);
    } finally {
      setIsLoading(false);
    }
  };

  const generateSetlistPlaylist = async () => {
    if (artistChips.length === 0) return;

    setIsLoading(true);
    setPlaylist([]);
    setSetlistProgress("");
    setSetlistStats(null);
    setGenerationStatus("fetching");
    console.debug(`[status] Transition: idle -> fetching`);

    const FILTER_SONGS = ["intro", "outro", "interlude", "tape", "unknown"];

    try {
      const resultsByArtist: Record<string, ArtistPlaylist> = {};
      const playlistUris: string[] = [];
      const tracksMissing: string[] = [];
      const missingSetlists: string[] = [];
      let totalSongsCount = 0;

      // Step 1: Fetch setlists for each artist
      for (let i = 0; i < artistChips.length; i++) {
        const artistName = artistChips[i];
        setSetlistProgress(`Buscando últimos conciertos de ${artistName}...`);

        try {
          // First, get artist MBID
          const artistRes = await fetch(`/api/setlist/artist?name=${encodeURIComponent(artistName)}`);
          if (!artistRes.ok) {
            console.error(`Failed to search artist: ${artistName}`);
            continue;
          }

          const artistData = await artistRes.json();

          // Robust MBID resolution with fallbacks
          const norm = (s: string) => s.toLowerCase().trim();
          let chosen = null;
          let candidates: any[] = [];

          if (artistData.best && artistData.best.mbid) {
            chosen = artistData.best;
          } else if (artistData.results && Array.isArray(artistData.results) && artistData.results.length > 0) {
            chosen = artistData.results.find((r: any) => r.mbid && norm(r.name) === norm(artistName)) || artistData.results.find((r: any) => r.mbid);
          }

          if (artistData.results && Array.isArray(artistData.results)) {
            candidates = artistData.results.filter((r: any) => r.mbid).slice(0, 5);
          }

          if (!chosen || !chosen.mbid) {
            console.error(`No MBID found for: ${artistName}`);
            missingSetlists.push(artistName);
            continue;
          }

          // Fetch union of last 5 setlists
          const setlistRes = await fetch(`/api/setlist/latest5union?mbid=${chosen.mbid}&limit=5`);
          let setlistData = null;

          if (setlistRes.ok) {
            setlistData = await setlistRes.json();
          }

          if (!setlistData || !setlistData.songs) {
            // NOTE: Empty songs is allowed now for fallback check
            setlistData = { songs: [], sources: [] };
          }

          if (setlistData.songs.length === 0) {
            console.log(`[setlist] No songs found in union for ${artistName}. Will attempt fallback.`);
          }

          const mostRecentSource = setlistData.sources?.[0];

          // Initialize local record for this artist using union results
          resultsByArtist[artistName] = {
            artist: artistName,
            tracks: [],
            originalSongCount: setlistData.songs.length,
            // Construct a URL for the most recent setlist if we have an ID
            setlistUrl: mostRecentSource?.id ? `https://www.setlist.fm/setlist/id/${mostRecentSource.id}.html` : undefined,
            metadata: {
              eventDate: mostRecentSource?.eventDate,
              venue: mostRecentSource?.venue?.name,
              city: mostRecentSource?.venue?.city
            },
            debugStats: setlistData.stats // Capture stats for debug
          };

          const songs = setlistData.songs;
          totalSongsCount += songs.length;

          if (songs.length > 0) {
            // STANDARD PATH: Setlist found with songs
            if (i === 0) {
              setGenerationStatus("resolving");
              console.debug(`[status] Transition: fetching -> resolving`);
            }

            // Step 2: Search Spotify for each song
            for (let j = 0; j < songs.length; j++) {
              const songName = songs[j];
              setSetlistProgress(`Buscando canciones de ${artistName} en Spotify... (${j + 1}/${songs.length})`);

              const normalizeSongTitle = (title: string): string => {
                return title.replace(/["'“”‘’]/g, '').replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/\s*\/\s*/g, ' ').replace(/[+=:;!?'"&]/g, '').replace(/\s+/g, ' ').trim();
              };

              const normalizeName = (s: string): string => {
                return s
                  .toLowerCase()
                  .normalize("NFD")
                  .replace(/\p{Diacritic}/gu, "")
                  .replace(/[^a-z0-9\s]/g, "")
                  .replace(/\s+/g, " ")
                  .trim();
              };

              const isArtistMatch = (targetArtist: string, trackArtists: string[]): boolean => {
                const target = normalizeName(targetArtist);
                if (!target) return false;
                const words = target.split(" ").filter(w => w.length > 0);

                return trackArtists.some(artistName => {
                  const normalized = normalizeName(artistName);
                  if (!normalized) return false;

                  // Exact match (normalized)
                  if (normalized === target) return true;

                  // Fallback for multi-word targets
                  if (words.length >= 2) {
                    return normalized.includes(target) || target.includes(normalized);
                  }

                  return false;
                });
              };

              const normalizedSong = normalizeSongTitle(songName);
              try {
                const spotifyRes = await fetch(`/api/spotify/search?track=${encodeURIComponent(normalizedSong)}&artist=${encodeURIComponent(artistName)}`);

                if (spotifyRes.ok) {
                  const resolution = await spotifyRes.json();

                  // If it's a valid resolution (strict or fallback)
                  if (resolution && resolution.id) {
                    const resolvedTrack = {
                      ...resolution,
                      artist: artistName, // Keep search artist for primary display
                      source: 'setlist'
                    };
                    resultsByArtist[artistName].tracks.push(resolvedTrack);
                    if (resolvedTrack.uri) {
                      playlistUris.push(resolvedTrack.uri);
                    }
                  } else {
                    console.debug(`[setlist] No resolution found for: ${artistName} - ${songName}`);
                    tracksMissing.push(`${artistName} - ${songName}`);
                  }
                } else {
                  tracksMissing.push(`${artistName} - ${songName}`);
                }
              } catch (err) {
                console.error(`[setlist] Error searching for song: ${songName}`, err);
                tracksMissing.push(`${artistName} - ${songName}`);
              }
            }
          } else {
            // FALLBACK PATH: No recent setlists -> Use Spotify Top Tracks
            console.log(`[setlist] No recent setlists for ${artistName}. Attempting Spotify Fallback.`);
            setSetlistProgress(`Usando Top Tracks de Spotify para ${artistName}...`);

            try {
              // Use generic search restricted to artist to simulate "Top Tracks" or "Popular"
              // Normalize artist name for search input
              const normalizeInput = (s: string) => s.replace(/^["']|["']$/g, "").trim().replace(/\s+/g, " ");
              const normalizedArtistInput = normalizeInput(artistName);

              // Helper to fetch keys
              // Helper to fetch keys
              const fetchFallback = async (query: string, limit: number = 10) => {
                const res = await fetch(`/api/spotify/search?q=${encodeURIComponent(query)}&limit=${limit}`);
                if (res.ok) {
                  const data = await res.json();
                  return Array.isArray(data) ? data : [];
                }
                return [];
              };

              // Attempt 1: Quoted
              let usedQuery = `artist:"${normalizedArtistInput}"`;
              let fallbackTracks = await fetchFallback(usedQuery, 10);
              let fallbackMethod = "quoted";

              // Attempt 2: Unquoted if empty
              if (fallbackTracks.length === 0) {
                console.log(`[setlist] Fallback attempt 1 (quoted) failed for ${normalizedArtistInput}. Retrying unquoted.`);
                usedQuery = `artist:${normalizedArtistInput}`;
                fallbackTracks = await fetchFallback(usedQuery, 10);
                fallbackMethod = "unquoted";
              }

              // Strict Filter Logic
              const normalizeName = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9\s]/g, "").trim();
              const isMatch = (t: any) => {
                const tArtist = normalizeName(t.artist);
                const targetNormalized = normalizeName(normalizedArtistInput);
                return tArtist.includes(targetNormalized) || targetNormalized.includes(tArtist);
              };

              let validFallback = fallbackTracks.filter(isMatch);

              // 2) Extension: If < 10, fetch more (up to 50)
              if (validFallback.length < 10 && fallbackTracks.length > 0) {
                console.log(`[setlist] Fallback yielded only ${validFallback.length} tracks. Extending search...`);
                const extendedTracks = await fetchFallback(usedQuery, 50);
                const validExtended = extendedTracks.filter(isMatch);

                // Merge unique tracks
                const existingIds = new Set(validFallback.map((t: any) => t.id));
                for (const t of validExtended) {
                  if (validFallback.length >= 10) break;
                  if (!existingIds.has(t.id)) {
                    validFallback.push(t);
                    existingIds.add(t.id);
                  }
                }
                // Update raw count for debug to reflect we fetched more
                fallbackTracks = extendedTracks;
              }

              // DEBUG LOGGING
              if (process.env.NODE_ENV !== 'production' || window.location.search.includes('debug=1')) {
                console.log(`[debug-fallback] ${artistName}: Raw=${fallbackTracks.length}, Filtered=${validFallback.length}`);
              }

              // Store fallback debug stats
              resultsByArtist[artistName].debugStats = {
                ...resultsByArtist[artistName].debugStats,
                rawCount: fallbackTracks.length,
                filteredCount: validFallback.length
              };

              if (validFallback.length > 0) {
                validFallback.forEach((t: any) => {
                  const trackObj = {
                    ...t,
                    artist: artistName,
                    source: 'spotify_top_tracks'
                  };
                  resultsByArtist[artistName].tracks.push(trackObj);
                  if (trackObj.uri) playlistUris.push(trackObj.uri);
                });
                // Update original count to reflect we found N tracks
                resultsByArtist[artistName].originalSongCount = validFallback.length;
                // DO NOT add to missingSetlists since we found content
              } else {
                missingSetlists.push(artistName);
              }
            } catch (fbErr) {
              console.error("Fallback error", fbErr);
              missingSetlists.push(artistName);
            }
          }
        } catch (err) {
          console.error(`Error processing artist: ${artistName}`, err);
        }
      }

      // Final state updates (atomic)
      // 1. Ensure order matches artistChips
      let orderedPlaylistData = artistChips
        .map(name => resultsByArtist[name])
        .filter(Boolean);

      // 2. Global Dedupe by URI
      const seenUris = new Set<string>();
      const dedupedPlaylistData = orderedPlaylistData.map(group => {
        const uniqueTracks = group.tracks.filter(track => {
          if (!track.uri) return true; // Keep tracks without URI? Usually implies error or not matched, but let's keep to show properly or filter later. Actually matched tracks have URI.
          if (seenUris.has(track.uri)) return false;
          seenUris.add(track.uri);
          return true;
        });
        return {
          ...group,
          tracks: uniqueTracks
        };
      });

      setPlaylist(dedupedPlaylistData);

      // 3. Recalculate Stats from Deduped Data
      const uniqueMatchedUris = new Set<string>();
      dedupedPlaylistData.forEach(g => {
        g.tracks.forEach(t => {
          if (t.uri) uniqueMatchedUris.add(t.uri);
        });
      });
      const matchedCount = uniqueMatchedUris.size;

      const missingObjects = tracksMissing.map(m => {
        const parts = m.split(" - ");
        return { artist: parts[0], song: parts[1] };
      });
      setMissingTracks(missingObjects);
      const missingCount = missingObjects.length;

      setSetlistStats({
        total: totalSongsCount,
        matched: matchedCount,
        missing: missingCount,
        missingSetlists: missingSetlists.length > 0 ? missingSetlists : undefined,
        fallbackUsed: dedupedPlaylistData.some(g => g.tracks.some(t => t.source === 'spotify_top_tracks')),
        debugInfo: Object.values(resultsByArtist).map(r => ({
          artist: r.artist,
          scanned: (r as any).debugStats?.setlistsScanned || 0,
          used: (r as any).debugStats?.setlistsUsed || 0,
          skippedEmpty: (r as any).debugStats?.skippedEmpty || 0,
          skippedOld: (r as any).debugStats?.skippedOld || 0,
          fallback: r.tracks.some(t => t.source === 'spotify_top_tracks'),
          rawCount: (r as any).debugStats?.rawCount,
          filteredCount: (r as any).debugStats?.filteredCount,
          finalCount: dedupedPlaylistData.find(g => g.artist === r.artist)?.tracks.length || 0
        }))
      });

      // Calculate final status
      let finalStatus: "success" | "partial" | "error" = "error";
      if (matchedCount > 0 && missingCount === 0) finalStatus = "success";
      else if (matchedCount > 0 && missingCount > 0) finalStatus = "partial";
      else if (matchedCount === 0) finalStatus = "error";

      setGenerationStatus(finalStatus);
      console.debug(`[status] Transition: resolving -> ${finalStatus}`);
      console.debug(`[status] Totals: setlist=${totalSongsCount}, matched=${matchedCount}, missing=${missingCount}`);

      // Consistency Check (Step 3)
      const sumMatched = dedupedPlaylistData.reduce((acc, g) => acc + g.tracks.length, 0);
      const sumTotal = dedupedPlaylistData.reduce((acc, g) => acc + g.originalSongCount, 0);
      if (sumMatched !== matchedCount || sumTotal !== totalSongsCount) {
        console.debug(`[consistency] Stats mismatch! globalMatch=${matchedCount} vs sumGroupMatch=${sumMatched}, globalTotal=${totalSongsCount} vs sumGroupTotal=${sumTotal}`);
      }

      if (dedupedPlaylistData.length > 0) {
        addToHistory(dedupedPlaylistData, artistChips);
      }

    } catch (e) {
      console.error("Critical error generating setlist playlist", e);
      setGenerationStatus("error");
    } finally {
      setIsLoading(false);
      setSetlistProgress("");
    }
  };

  const retryMissingSongs = async () => {
    if (missingTracks.length === 0 || isRetrying) return;
    setIsRetrying(true);
    setSetlistProgress("Reintentando canciones no encontradas...");

    const currentPlaylist = [...playlist];
    const newMissingTracks: { artist: string; song: string }[] = [];
    let newlyFoundCount = 0;

    // Helper for artist match validation
    const normalizeName = (s: string): string => {
      return s
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    };

    const isArtistMatch = (targetArtist: string, trackArtists: string[]): boolean => {
      const target = normalizeName(targetArtist);
      if (!target) return false;
      const words = target.split(" ").filter(w => w.length > 0);

      return trackArtists.some(artistName => {
        const normalized = normalizeName(artistName);
        if (!normalized) return false;
        if (normalized === target) return true;
        if (words.length >= 2) {
          return normalized.includes(target) || target.includes(normalized);
        }
        return false;
      });
    };

    const normalizeSongTitle = (title: string): string => {
      return title.replace(/["'“”‘’]/g, '').replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/\s*\/\s*/g, ' ').replace(/[+=:;!?'"&]/g, '').replace(/\s+/g, ' ').trim();
    };

    for (const item of missingTracks) {
      const { artist, song } = item;
      const songClean = normalizeSongTitle(song);
      let foundTrack: any = null;

      try {
        const res = await fetch(`/api/spotify/search?track=${encodeURIComponent(songClean)}&artist=${encodeURIComponent(artist)}`);
        if (res.ok) {
          foundTrack = await res.json();
        }
      } catch (e) { /* skip */ }

      if (foundTrack && foundTrack.id) {
        // Patch playlist data
        const artistGroup = currentPlaylist.find(g => g.artist === artist);
        if (artistGroup) {
          artistGroup.tracks.push({ ...foundTrack, artist });
          newlyFoundCount++;
        }
      } else {
        newMissingTracks.push(item);
      }
    }

    if (newlyFoundCount > 0) {
      setPlaylist(currentPlaylist);
      setMissingTracks(newMissingTracks);

      // Re-calculate stats
      const totalMatched = currentPlaylist.reduce((acc, g) => acc + g.tracks.length, 0);
      const totalOriginal = currentPlaylist.reduce((acc, g) => acc + g.originalSongCount, 0);
      const totalMissing = newMissingTracks.length;

      setSetlistStats(prev => ({
        ...prev!,
        matched: totalMatched,
        missing: totalMissing
      }));

      // Update status
      let finalStatus: "success" | "partial" | "error" = "error";
      if (totalMatched > 0 && totalMissing === 0) finalStatus = "success";
      else if (totalMatched > 0 && totalMissing > 0) finalStatus = "partial";
      else if (totalMatched === 0) finalStatus = "error";
      setGenerationStatus(finalStatus);
    }

    setIsRetrying(false);
    setSetlistProgress("");
  };

  const addToHistory = (playlistData: ArtistPlaylist[], artists: string[]) => {
    // Flatten tracks for storage
    const flatTracks = playlistData.flatMap(group =>
      group.tracks.map(track => ({
        artist: group.artist,
        title: track.title,
        url: track.url,
        uri: track.uri,
        durationMs: track.durationMs
      }))
    );

    if (flatTracks.length === 0) return;

    const artistMetadata: Record<string, { eventDate?: string; venue?: string; city?: string }> = {};
    playlistData.forEach(p => {
      if (p.metadata) {
        artistMetadata[p.artist] = p.metadata;
      }
    });

    const numArtists = artists.length;
    const numTracks = flatTracks.filter(t => t.uri).length;

    const newDraft: PlaylistDraft & { source?: string; stats?: any } = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      artists: [...artists],
      artistMetadata: Object.keys(artistMetadata).length > 0 ? artistMetadata : undefined,
      tracks: flatTracks,
      source: "setlists",
      stats: {
        totalSetlist: flatTracks.length,
        foundSpotify: numTracks
      }
    };

    setHistory(prev => {
      const updated = [newDraft, ...prev].slice(0, 5);
      try {
        localStorage.setItem("setifest_history", JSON.stringify(updated));
      } catch (e) {
        console.error("Failed to save history", e);
      }
      return updated;
    });

    setCurrentDraftId(newDraft.id);
  };

  const loadDraft = (draft: PlaylistDraft) => {
    setArtistChips(draft.artists);
    setCurrentDraftId(draft.id);

    const grouped = convertDraftToPlaylist(draft);
    setPlaylist(grouped);

    // CRITICAL: The tracks update above will trigger a useEffect that resets
    // createdPlaylistUrl to null. We need to set the draft's URL *after* that effect runs.
    // A 0ms timeout puts this at the end of the event loop/after effects.
    setTimeout(() => {
      setCreatedPlaylistUrl(draft.playlistUrl || null);
    }, 0);
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem("setifest_history");
  };

  return (
    <main className="flex min-h-screen flex-col items-center p-8 sm:p-24 bg-[var(--background)] text-[var(--foreground)]">
      <div className="w-full max-w-2xl flex flex-col gap-8">
        {/* Header & Connection Status */}
        <div className="flex flex-col items-center gap-4 w-full">
          <div className="flex w-full justify-between items-center">
            <h1 className="text-4xl font-bold tracking-tight text-[var(--foreground)]">
              SetiFest
            </h1>

            <div className="flex items-center gap-3">
              {isConnected ? (
                <>
                  <span className="hidden sm:inline-block text-xs font-medium text-[#1DB954] bg-[#1DB954]/10 px-3 py-1.5 rounded-full border border-[#1DB954]/20">
                    Conectado como {userProfile?.display_name || "Usuario"}
                  </span>
                  <button
                    onClick={handleLogout}
                    className="text-xs text-[var(--secondary)] hover:text-white transition-colors"
                  >
                    Desconectar
                  </button>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="hidden sm:inline-block text-xs font-medium text-[var(--secondary)] bg-[#2A2A2E] px-3 py-1.5 rounded-full">
                    No conectado
                  </span>
                  <a
                    href="/api/spotify/login"
                    className="text-xs font-bold text-[#1DB954] hover:text-[#1ed760] transition-colors"
                  >
                    Conectar Spotify
                  </a>
                </div>
              )}
            </div>
          </div>
          {/* Mobile-only status pill */}
          {isConnected && (
            <span className="sm:hidden text-xs font-medium text-[#1DB954] bg-[#1DB954]/10 px-3 py-1 rounded-full border border-[#1DB954]/20 self-start">
              {userProfile?.display_name || "Usuario"}
            </span>
          )}
        </div>

        {/* Poster Upload Section */}
        <div
          className={`w-full border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center transition-all cursor-pointer relative overflow-hidden group
                ${posterPreviewUrl ? "border-[#1DB954]/50 bg-[#1DB954]/5" : "border-[#2A2A2E] hover:border-[#F1F1F1]/50 bg-[#1A1A1C] hover:bg-[#222]"}
            `}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onClick={() => {
            if (!posterPreviewUrl) {
              document.getElementById("poster-upload")?.click();
            }
          }}
        >
          <input
            type="file"
            id="poster-upload"
            className="hidden"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileSelect(file);
            }}
          />

          {posterPreviewUrl ? (
            <div className="relative w-full flex flex-col items-center gap-4 z-10">
              <img
                src={posterPreviewUrl}
                alt="Poster preview"
                className="max-h-[300px] rounded-lg shadow-2xl"
              />

              <div className="flex flex-col gap-3 w-full max-w-xs">
                {isOcrLoading ? (
                  <div className="flex items-center justify-center gap-2 bg-black/50 px-4 py-2 rounded-full backdrop-blur-md text-white text-sm">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                    Procesando cartel...
                  </div>
                ) : (
                  <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        extractArtistsFromPoster();
                      }}
                      className="w-full bg-[#1DB954] text-black font-bold py-2 px-4 rounded-full text-sm hover:scale-105 transition-transform shadow-lg"
                    >
                      Extraer artistas del cartel
                    </button>
                    {ocrText && (
                      <div className="flex flex-col gap-2 animate-in fade-in">
                        <div className="flex items-center justify-center gap-2 text-[#1DB954] text-xs font-bold">
                          <span>✓ Procesado</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); setShowRawOcr(!showRawOcr); }}
                            className="underline opacity-80 hover:opacity-100"
                          >
                            {showRawOcr ? "Ocultar texto" : "Ver texto OCR"}
                          </button>
                        </div>
                        {showRawOcr && (
                          <textarea
                            readOnly
                            value={ocrText}
                            className="w-full h-24 text-xs bg-black/50 text-white/70 p-2 rounded border border-white/10"
                            onClick={e => e.stopPropagation()}
                          />
                        )}
                      </div>
                    )}
                    {ocrError && (
                      <div className="text-red-400 text-xs font-medium bg-red-400/10 px-2 py-1 rounded">
                        {ocrError}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Review Section */}
              {ocrCandidates.length > 0 && !isOcrLoading && (
                <div className="w-full mt-4 flex flex-col gap-4 animate-in fade-in slide-in-from-top-4 text-left border-t border-white/10 pt-4">
                  <div className="flex justify-between items-center">
                    <h3 className="font-bold text-white text-sm">Revisa los artistas detectados</h3>
                    <span className="text-xs text-[var(--secondary)]">
                      Detectados: {ocrCandidates.length} · Seleccionados: {ocrCandidates.filter(c => c.selected).length}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-2 mb-2">
                    <button onClick={handleSelectAll} className="px-3 py-1 bg-[#2A2A2E] hover:bg-[#3A3A3E] rounded text-xs text-white transition-colors">Todo</button>
                    <button onClick={handleDeselectAll} className="px-3 py-1 bg-[#2A2A2E] hover:bg-[#3A3A3E] rounded text-xs text-white transition-colors">Nada</button>
                    <button onClick={handleCleanNoise} className="px-3 py-1 bg-[#2A2A2E] hover:bg-[#3A3A3E] rounded text-xs text-[var(--secondary)] hover:text-white transition-colors flex items-center gap-1">
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
                      Limpiar ruido
                    </button>
                  </div>

                  <div className="flex flex-col gap-2 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar border border-[#2A2A2E] rounded-lg p-2 bg-black/20">
                    {ocrCandidates.map(candidate => (
                      <div key={candidate.id} className={`flex items-center gap-3 p-2 rounded transition-colors ${candidate.selected ? 'bg-[#1DB954]/10' : 'hover:bg-white/5'}`}>
                        <input
                          type="checkbox"
                          checked={candidate.selected}
                          onChange={() => toggleCandidate(candidate.id)}
                          className="accent-[#1DB954] w-4 h-4 cursor-pointer"
                        />
                        <div className="flex-1 min-w-0">
                          {editingCandidateId === candidate.id ? (
                            <input
                              autoFocus
                              value={candidate.text}
                              onChange={(e) => updateCandidateText(candidate.id, e.target.value)}
                              onBlur={() => setEditingCandidateId(null)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") setEditingCandidateId(null);
                                if (e.key === "Escape") setEditingCandidateId(null);
                              }}
                              className="w-full bg-black/50 border border-white/20 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-[#1DB954]"
                            />
                          ) : (
                            <span
                              onClick={() => setEditingCandidateId(candidate.id)}
                              className="block text-sm text-[var(--foreground)] truncate cursor-text hover:text-white"
                              title="Clic para editar"
                            >
                              {candidate.text}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={handleAddSelected}
                      disabled={ocrCandidates.filter(c => c.selected).length === 0}
                      className="flex-1 py-3 bg-[#1DB954] text-black font-bold rounded-lg hover:bg-[#1ed760] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      Añadir {ocrCandidates.filter(c => c.selected).length} artistas
                    </button>

                    <button
                      onClick={handleAddAllAndContinue}
                      className="flex-1 py-3 border border-[#1DB954] text-[#1DB954] font-bold rounded-lg hover:bg-[#1DB954]/10 transition-all"
                    >
                      Añadir todo y continuar
                    </button>
                  </div>
                </div>
              )}


              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removePoster();
                }}
                className="absolute top-2 right-2 p-2 bg-black/50 text-white rounded-full hover:bg-red-500/80 transition-colors backdrop-blur-md"
                title="Quitar cartel"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-[#2A2A2E] flex items-center justify-center text-[var(--secondary)] group-hover:scale-110 transition-transform">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="17 8 12 3 7 8"></polyline>
                  <line x1="12" y1="3" x2="12" y2="15"></line>
                </svg>
              </div>
              <p className="text-sm font-medium text-[var(--secondary)] group-hover:text-white transition-colors">
                Arrastra aquí el cartel del festival o haz clic para subirlo
              </p>
              <p className="text-xs text-[#505050]">Soporta PNG, JPG</p>
            </div>
          )}
        </div>

        {/* Input Section */}
        <div className="flex flex-col gap-4">
          <label htmlFor="artist-input" className="text-sm font-medium text-[var(--secondary)]">
            Paste your artists (one per line)
          </label>
          <textarea
            id="artist-input"
            className="w-full min-h-[150px] p-4 rounded-xl bg-[#1A1A1C] border border-[#2A2A2E] text-[var(--foreground)] placeholder-[#505050] focus:outline-none focus:ring-2 focus:ring-[#F1F1F1] transition-all resize-y"
            placeholder="Metallica&#10;Iron Maiden&#10;Black Sabbath"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
          <button
            onClick={handleAddArtists}
            disabled={!inputText.trim()}
            className="self-end px-6 py-2 rounded-full bg-[var(--foreground)] text-[var(--background)] font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            Add Artists
          </button>
        </div>

        {/* Chips Section */}
        {artistChips.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium text-[var(--secondary)]">
                Artists ({artistChips.length})
              </span>
              <button
                onClick={() => {
                  setArtistChips([]);
                  resetSetlistGeneration();
                }}
                className="text-xs text-red-400 hover:text-red-300 transition-colors"
                disabled={isLoading}
              >
                Clear all
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              {artistChips.map((artist) => (
                <div
                  key={artist}
                  className="group flex items-center gap-2 pl-4 pr-2 py-1.5 rounded-full bg-[#1A1A1C] border border-[#2A2A2E] hover:border-[#3A3A3E] transition-colors"
                >
                  <span className="text-sm text-[var(--foreground)]">{artist}</span>
                  <button
                    onClick={() => removeArtist(artist)}
                    className="p-1 rounded-full text-[var(--secondary)] hover:bg-[#2A2A2E] hover:text-[#F1F1F1] transition-colors"
                    aria-label={`Remove ${artist}`}
                    disabled={isLoading}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Hint if 0 artists */
          <div className="p-8 rounded-lg border border-dashed border-[#2A2A2E] text-center bg-[#111113]">
            <p className="text-base text-[var(--secondary)] mb-2">Ready to build your lineup?</p>
            <p className="text-sm text-[#666]">Add artist names above to fetch their top tracks from Spotify.</p>
          </div>
        )}

        {/* Action Section */}
        <div className="flex flex-col gap-4">
          <button
            id="generate-playlist-btn"
            onClick={generatePlaylist}
            disabled={artistChips.length === 0 || isLoading}
            className="w-full py-4 rounded-xl bg-[#F1F1F1] text-[#0D0D0F] font-bold text-lg hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-lg shadow-white/5 disabled:shadow-none active:scale-[0.99]"
          >
            {isLoading && !isCreatingPlaylist ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5 text-[#0D0D0F]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Fetching from Spotify...
              </span>
            ) : (
              "Generar playlist (demo)"
            )}
          </button>

          <button
            onClick={generateSetlistPlaylist}
            disabled={artistChips.length === 0 || isLoading}
            className="w-full py-4 rounded-xl bg-[#1DB954] text-black font-bold text-lg hover:bg-[#1ed760] disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-lg shadow-[#1DB954]/20 disabled:shadow-none active:scale-[0.99]"
          >
            {isLoading && generationStatus !== "idle" ? (
              <span className="flex flex-col items-center justify-center gap-1">
                <span className="flex items-center gap-2 text-sm">
                  <svg className="animate-spin h-4 w-4 text-black" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  {generationStatus === "fetching" ? "Buscando conciertos recientes con repertorio real…" : "Emparejando canciones en Spotify…"}
                </span>
                {setlistProgress && <span className="text-[10px] opacity-70 font-normal">{setlistProgress}</span>}
              </span>
            ) : (
              "Generar desde Setlists 🎸"
            )}
          </button>

          {generationStatus !== "idle" && generationStatus !== "fetching" && generationStatus !== "resolving" && setlistStats && (
            <div className={`p-5 rounded-xl border animate-in fade-in slide-in-from-top-4 duration-300 ${generationStatus === "success" ? "bg-[#1DB954]/10 border-[#1DB954]/50" :
              generationStatus === "partial" ? "bg-orange-500/10 border-orange-500/50" :
                "bg-red-500/10 border-red-500/50"
              }`}>
              <div className="flex items-center gap-3 mb-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${generationStatus === "success" ? "bg-[#1DB954] text-black" :
                  generationStatus === "partial" ? "bg-orange-500 text-black" :
                    "bg-red-500 text-white"
                  }`}>
                  {generationStatus === "success" && "✓"}
                  {generationStatus === "partial" && "!"}
                  {generationStatus === "error" && "✕"}
                </div>
                <div>
                  <h4 className="font-bold text-lg leading-tight">
                    {generationStatus === "success" ? "¡Playlist lista!" :
                      generationStatus === "partial" ? "Playlist generada con faltantes" :
                        "No se pudo generar"}
                  </h4>
                  <p className="text-xs opacity-70">
                    {generationStatus === "success" ? "Todas las canciones han sido emparejadas." :
                      generationStatus === "partial" ? "Algunas canciones del setlist no están en Spotify." :
                        "Intenta ajustar los nombres de los artistas."}
                  </p>
                  <p className="text-[10px] opacity-40 mt-1 italic">
                    Basado en los últimos 5 conciertos
                  </p>

                  {/* Fallback Warning */}
                  {setlistStats.fallbackUsed && (
                    <div className="mt-2 p-2 rounded bg-yellow-500/10 border border-yellow-500/20 text-[10px] text-yellow-200/80 flex items-start gap-2">
                      <span className="text-yellow-500 font-bold">⚠</span>
                      <span>Algunos artistas no tienen conciertos recientes disponibles; se han usado sus canciones más escuchadas.</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Debug Section */}
              {typeof window !== 'undefined' && new URLSearchParams(window.location.search).get("debug") === "1" && setlistStats.debugInfo && (
                <div className="mt-3 border-t border-white/5 pt-2">
                  <p className="text-[9px] font-mono text-white/30 uppercase mb-1">Debug Stats</p>
                  <div className="grid grid-cols-1 gap-1 max-h-32 overflow-y-auto text-[9px] font-mono text-white/50 bg-black/20 p-2 rounded">
                    {setlistStats.debugInfo.map((info: any, idx: number) => (
                      <div key={idx} className="flex justify-between border-b border-white/5 last:border-0 pb-1">
                        <span>{info.artist}</span>
                        <div className="flex gap-2 flex-wrap justify-end">
                          {info.fallback ? (
                            <>
                              <span className="text-yellow-500/80">Raw:{info.rawCount ?? '?'}</span>
                              <span className="text-yellow-500/80">Filt:{info.filteredCount ?? '?'}</span>
                              <span className="text-green-500/80">Final:{info.finalCount ?? '?'}</span>
                            </>
                          ) : (
                            <>
                              <span>Scan:{info.scanned}</span>
                              <span>Used:{info.used}</span>
                              <span>Skip0:{info.skippedEmpty}</span>
                              <span>SkipOld:{info.skippedOld}</span>
                            </>
                          )}
                          <span className={info.fallback ? "text-yellow-500 font-bold" : "text-green-500 font-bold"}>
                            {info.fallback ? "FALLBACK" : "SETLIST"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 text-center border-t border-white/5 pt-3">
                <div>
                  <span className="block text-xl font-black leading-none mb-1">{setlistStats.total}</span>
                  <span className="text-[10px] uppercase opacity-50">Setlist</span>
                </div>
                <div>
                  <span className="block text-xl font-black leading-none mb-1 text-[#1DB954]">{setlistStats.matched}</span>
                  <span className="text-[10px] uppercase opacity-50 text-[#1DB954]">Spotify</span>
                </div>
                <div>
                  <span className="block text-xl font-black leading-none mb-1 text-red-400">{setlistStats.missing}</span>
                  <span className="text-[10px] uppercase opacity-50 text-red-400">Missing</span>
                </div>
              </div>

              {setlistStats.missingSetlists && setlistStats.missingSetlists.length > 0 && (
                <p className="text-red-400/80 mt-3 text-[10px] italic">
                  No se encontraron setlists para: {setlistStats.missingSetlists.join(", ")}
                </p>
              )}

              {missingTracks.length > 0 && (
                <div className="mt-4 pt-4 border-t border-white/5">
                  <button
                    onClick={retryMissingSongs}
                    disabled={isRetrying || isLoading}
                    className="w-full py-2.5 rounded-lg bg-white/5 border border-white/10 text-xs font-bold text-white hover:bg-white/10 transition-all flex justify-center items-center gap-2 group"
                  >
                    {isRetrying ? (
                      <>
                        <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
                        Reintentando...
                      </>
                    ) : (
                      <>
                        <span className="opacity-60 group-hover:opacity-100 transition-opacity">↻</span>
                        Reintentar {missingTracks.length} no encontradas
                      </>
                    )}
                  </button>
                </div>
              )}

              {missingTracks.length > 0 && (
                <div className="mt-4 p-4 rounded-xl bg-red-400/5 border border-red-400/10 flex flex-col gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider">No encontradas ({missingTracks.length})</span>
                      <button
                        onClick={() => setShowMissingPanel(!showMissingPanel)}
                        className="text-[10px] text-white/40 hover:text-white underline font-medium transition-colors"
                      >
                        {showMissingPanel ? "Ocultar" : "Ver"}
                      </button>
                    </div>
                    {showMissingPanel && (
                      <button
                        onClick={handleCopyMissing}
                        className="text-[10px] text-white/60 hover:text-white border border-white/10 px-2 py-0.5 rounded transition-all active:scale-95"
                      >
                        Copiar
                      </button>
                    )}
                  </div>

                  {showMissingPanel && (
                    <div className="flex flex-col gap-3 mt-1 max-h-60 overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-white/10">
                      {Object.entries(groupedMissing).map(([artist, songs]) => (
                        <div key={artist} className="flex flex-col gap-1">
                          <span className="text-[11px] font-bold text-white/80">{artist}</span>
                          <div className="flex flex-wrap gap-1">
                            {songs.map((song, i) => (
                              <span key={i} className="text-[10px] bg-white/5 border border-white/10 px-2 py-0.5 rounded text-[var(--secondary)]">
                                {song}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}


          <button
            type="button"
            onClick={handleMainCreateClick}
            disabled={!canCreatePlaylist}
            className={`w-full py-4 rounded-xl font-bold text-lg transition-all flex flex-col justify-center items-center gap-1
                ${canCreatePlaylist
                ? "bg-[#1DB954] text-black hover:bg-[#1ed760] shadow-lg shadow-[#1DB954]/20 active:scale-[0.99]"
                : "bg-[#2A2A2E] text-white/30 cursor-not-allowed border border-white/5 opacity-50"
              }
             `}
          >
            {createdPlaylistUrl ? (
              "Playlist ya creada"
            ) : isCreatingPlaylist ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-5 w-5 text-black" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Creando...
              </span>
            ) : (
              "Crear playlist en Spotify"
            )}
          </button>

          {generationStatus === "error" && setlistStats && (
            <p className="text-center text-red-400/80 text-xs mt-1 animate-in fade-in slide-in-from-top-1">
              No hay canciones válidas para crear la playlist.
            </p>
          )}

          {generationStatus === "partial" && setlistStats && canCreatePlaylist && (
            <p className="text-center text-orange-400/80 text-[10px] mt-1 italic animate-in fade-in slide-in-from-top-1 px-4">
              Se creará la playlist solo con las canciones encontradas en Spotify.
            </p>
          )}

          {createdPlaylistUrl && (
            <div className="bg-[#1DB954]/10 border border-[#1DB954]/20 p-4 rounded-xl flex justify-between items-center animate-in fade-in slide-in-from-top-2">
              <div className="flex flex-col">
                <span className="text-[#1DB954] font-bold text-sm">Playlist creada</span>
                <span className="text-xs text-[var(--secondary)]">Ready to listen!</span>
              </div>
              <a
                href={createdPlaylistUrl}
                target="_blank"
                rel="noreferrer"
                className="bg-[#1DB954] text-black px-4 py-2 rounded-full text-xs font-bold hover:scale-105 transition-transform"
              >
                Abrir playlist
              </a>
            </div>
          )}

          {debugEnabled && (
            <div className="p-4 rounded-xl bg-black/40 border border-white/5 font-mono text-[10px] overflow-hidden">
              <p className="text-[#1DB954] mb-3 font-bold uppercase tracking-widest text-[11px] flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#1DB954] animate-pulse"></span>
                Debug Console
              </p>
              <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-1.5 p-2 bg-black/20 rounded-lg">
                <span className="opacity-40">Status:</span>
                <span className={`font-bold ${generationStatus === "success" ? "text-green-400" :
                  generationStatus === "partial" ? "text-orange-400" :
                    generationStatus === "error" ? "text-red-400" :
                      "text-blue-400"
                  }`}>{generationStatus.toUpperCase()}</span>

                <span className="opacity-40">Setlist:</span>
                <span className="text-white">{setlistStats?.total || 0} tracks</span>

                <span className="opacity-40">Spotify+:</span>
                <span className="text-[#1DB954]">{setlistStats?.matched || 0} matched</span>

                <span className="opacity-40">Missing:</span>
                <span className="text-red-400">{setlistStats?.missing || 0} failed</span>

                <span className="opacity-40">Artists:</span>
                <span className="text-white">{artistChips.length}</span>
              </div>
            </div>
          )}
        </div>

        {/* Results Section */}
        {playlist.length > 0 && (
          <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <h2 className="text-2xl font-bold text-[var(--foreground)] border-b border-[#2A2A2E] pb-2">
              Generated Setlist
            </h2>
            <div className="flex flex-col gap-8">
              {playlist.map((group) => {
                const missing = group.originalSongCount - group.tracks.length;
                const formattedArtist = group.artist;
                const matchedTracks = group.tracks.filter(t => t.url || t.uri);

                const handleCopyFound = () => {
                  const titles = matchedTracks.map(t => t.title).join("\n");
                  navigator.clipboard.writeText(titles);
                };

                return (
                  <div key={group.artist} className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5 p-4 rounded-xl bg-white/5 border border-white/5">
                      <div className="flex items-center justify-between w-full mb-1">
                        <div className="flex items-center gap-3">
                          <span className="w-1.5 h-6 bg-[#1DB954] rounded-full"></span>
                          <h3 className="text-xl font-bold text-[#F1F1F1]">{formattedArtist}</h3>
                        </div>
                        <div className="flex items-center gap-2">
                          {group.setlistUrl && (
                            <a
                              href={group.setlistUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[10px] text-[#1DB954] font-bold uppercase border border-[#1DB954]/30 px-2 py-1 rounded hover:bg-[#1DB954]/10 transition-colors"
                            >
                              Ver Setlist
                            </a>
                          )}
                          {matchedTracks.length > 0 && (
                            <button
                              onClick={handleCopyFound}
                              className="text-[10px] text-white/60 font-medium uppercase border border-white/10 px-2 py-1 rounded hover:bg-white/5 transition-colors"
                            >
                              Copiar canciones
                            </button>
                          )}
                        </div>
                      </div>

                      {group.metadata && (
                        <div className="text-[11px] text-[var(--secondary)] flex items-center flex-wrap gap-x-2 gap-y-1 mb-2">
                          <span className="font-medium">{group.metadata.eventDate}</span>
                          <span className="opacity-30">•</span>
                          <span className="opacity-80">{group.metadata.venue}{group.metadata.city ? `, ${group.metadata.city}` : ""}</span>
                        </div>
                      )}

                      <div className="flex items-center gap-4 text-[11px] font-medium text-[var(--secondary)]">
                        <div className="flex items-center gap-1">
                          Setlist: <span className="text-white font-bold">{group.originalSongCount}</span> canciones
                        </div>
                        <div className="flex items-center gap-1">
                          Spotify: <span className="text-[#1DB954] font-bold">{group.tracks.length}</span> encontradas
                        </div>
                        {missing > 0 && (
                          <div className="flex items-center gap-1 text-red-400">
                            Missing: <span className="font-bold">{missing}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {matchedTracks.length > 0 ? (
                      <div className="flex flex-col gap-1 pl-1">
                        {matchedTracks.map((track, idx) => (
                          <div key={idx} className="flex items-center gap-4 p-3 rounded-lg hover:bg-white/5 transition-colors group/track cursor-default justify-between">
                            <div className="flex items-center gap-4 min-w-0">
                              <span className="text-xs font-mono text-[var(--secondary)] w-6 text-right shrink-0 opacity-40">{idx + 1}</span>
                              <div className="flex flex-col min-w-0">
                                <span className="text-sm text-[var(--foreground)] group-hover/track:text-white truncate font-medium">{track.title}</span>
                              </div>
                            </div>

                            <div className="flex items-center gap-4 shrink-0">
                              <span className="text-xs font-mono text-[var(--secondary)] opacity-50">{formatDuration(track.durationMs)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="p-6 rounded-xl border border-dashed border-white/10 text-center">
                        <p className="text-sm text-white/40 italic">
                          No se encontraron canciones en Spotify para este artista.
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* History Section */}
        {history.length > 0 && (
          <div className="flex flex-col gap-4 pt-10 border-t border-[#2A2A2E]">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold text-[var(--foreground)]">Historial</h2>
              <button
                onClick={clearHistory}
                className="text-xs text-red-400 hover:text-red-300 transition-colors"
                disabled={isLoading}
              >
                Borrar historial
              </button>
            </div>
            <div className="flex flex-col gap-3">
              {history.map((draft) => (
                <div key={draft.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-lg bg-[#111] border border-[#222] hover:border-[#333] transition-colors gap-3 sm:gap-0">
                  <div className="flex flex-col gap-1">
                    {draft.playlistName && (
                      <span className="text-base font-bold text-white mb-0.5">
                        {draft.playlistName}
                      </span>
                    )}
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-[var(--foreground)]">
                        {new Date(draft.createdAt).toLocaleString()}
                      </span>
                      {(draft as any).source === "setlists" && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#1DB954]/20 text-[#1DB954] font-bold border border-[#1DB954]/20 uppercase">
                          Setlists
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-[var(--secondary)]">
                      {draft.artists.length} artistas • {draft.tracks.length} canciones
                      {(draft as any).stats && (
                        <> • <span className="text-white/60">{(draft as any).stats.foundSpotify} matched</span></>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 self-start sm:self-auto">
                    {draft.playlistUrl ? (
                      <a
                        href={draft.playlistUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="px-3 py-1.5 rounded text-xs font-semibold bg-[#1DB954] text-black hover:bg-[#1ed760] transition-colors"
                      >
                        Abrir Playlist
                      </a>
                    ) : (
                      // Only show Create button if we have tracks and connection
                      draft.tracks.length > 0 && isConnected && (
                        <button
                          onClick={async () => {
                            // 1. Convert draft to playlist format
                            const playlistData = convertDraftToPlaylist(draft);

                            // 2. Load into UI state
                            loadDraft(draft);

                            // 3. Create playlist using explicit data
                            // Note: We could ask name here too, but per requirement we only do it for main flow for now.
                            // Pass undefined name to auto-generate from draft data using helper inside function.
                            await createSpotifyPlaylist(playlistData, draft.id);
                          }}
                          className="px-3 py-1.5 rounded text-xs font-semibold bg-[#2A2A2E] text-[var(--foreground)] border border-[#1DB954]/50 hover:bg-[#1DB954]/20 transition-colors"
                          disabled={isLoading}
                        >
                          Crear Playlist
                        </button>
                      )
                    )}

                    <button
                      onClick={() => loadDraft(draft)}
                      className="px-3 py-1.5 rounded text-xs font-semibold bg-[#2A2A2E] text-[var(--foreground)] hover:bg-[#3A3A3E] transition-colors"
                      disabled={isLoading}
                    >
                      Cargar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Name Modal */}
      {
        showNameModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="w-full max-w-md bg-[#1A1A1C] border border-[#2A2A2E] rounded-xl p-6 shadow-2xl flex flex-col gap-4 animate-in zoom-in-95 duration-200">
              <h3 className="text-lg font-bold text-white">Nombre de la playlist</h3>
              <input
                type="text"
                value={customPlaylistName}
                onChange={(e) => setCustomPlaylistName(e.target.value)}
                className="w-full bg-[#111] border border-[#333] rounded-lg px-4 py-2 text-white focus:outline-none focus:border-[#1DB954] transition-colors"
                autoFocus
              />
              <div className="flex gap-3 justify-end mt-2">
                <button
                  onClick={() => setShowNameModal(false)}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-[var(--secondary)] hover:text-white transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => {
                    setShowNameModal(false);
                    createSpotifyPlaylist(undefined, undefined, customPlaylistName);
                  }}
                  disabled={!customPlaylistName.trim()}
                  className="px-4 py-2 rounded-lg text-sm font-bold bg-[#1DB954] text-black hover:bg-[#1ed760] disabled:opacity-50 transition-colors"
                >
                  Crear
                </button>
              </div>
            </div>
          </div>
        )
      }
    </main>
  );
}
