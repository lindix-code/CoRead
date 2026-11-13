// Öffentliche Supabase-Zugangsdaten. Der "publishable key" darf im Code stehen,
// solange Row Level Security aktiv ist (siehe supabase/schema.sql).
// NIEMALS den "secret"- oder "service_role"-Key hier eintragen.
const SUPABASE_URL = "https://encfxlzynbqomyigihuc.supabase.co";
const SUPABASE_KEY = "sb_publishable_MnbW0OlIgP2D5apZp8A7zw_jpHBJzMp";

// Optional: eigener Google-Books-API-Schlüssel (hebt das Anfragelimit auf).
// Er darf im Code stehen, wenn er in der Google Cloud Console auf die Website
// (HTTP-Referrer) und die "Books API" beschränkt ist.
const GOOGLE_BOOKS_KEY = "AIzaSyAP-ui1t62N9p3TkahI2auaDY2_XB5u760";
