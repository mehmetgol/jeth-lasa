// 1. Orijinal tipleri kütüphaneden çek
import type * as PDFJS from 'pdfjs-dist';

// 2. Kullandığın alt yolları (sub-paths) modül olarak tanımla
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
    export * from "pdfjs-dist";
}

// 3. Eğer webpack kullanıyorsan bunu da ekleyebilirsin
declare module "pdfjs-dist/webpack.mjs" {
    export * from "pdfjs-dist";
}
