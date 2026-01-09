
import { NextRequest, NextResponse } from "next/server";
import Tesseract from "tesseract.js";
import sharp from "sharp";

// Force Node.js runtime for Tesseract/Sharp
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("image") as File;

        if (!file) {
            return NextResponse.json(
                { error: "No image provided" },
                { status: 400 }
            );
        }

        // Convert File to Buffer
        const arrayBuffer = await file.arrayBuffer();
        const inputBuffer = Buffer.from(arrayBuffer);

        // Preprocess with Sharp
        const processedBuffer = await sharp(inputBuffer)
            .resize({ width: 1400, withoutEnlargement: true }) // Limit size for speed
            .grayscale() // Improve text contrast
            .linear(1.2, -10) // Increase contrast slightly
            .png()
            .toBuffer();

        // OCR with Timeout Promise Race
        const ocrPromise = Tesseract.recognize(
            processedBuffer,
            "eng",
            { logger: () => { } }
        );

        const timeoutPromise = new Promise<{ data: { text: null } }>((_, reject) =>
            setTimeout(() => reject(new Error("OCR timeout")), 30000)
        );

        const result = await Promise.race([ocrPromise, timeoutPromise]);

        // Type guard/check
        if (!result || !result.data || typeof result.data.text !== 'string') {
            throw new Error("Invalid OCR result");
        }

        return NextResponse.json({ text: result.data.text });

    } catch (error: any) {
        console.error("OCR Error:", error);

        if (error.message === "OCR timeout") {
            return NextResponse.json(
                { error: "OCR timeout" },
                { status: 504 }
            );
        }

        return NextResponse.json(
            { error: "Failed to process image" },
            { status: 500 }
        );
    }
}
