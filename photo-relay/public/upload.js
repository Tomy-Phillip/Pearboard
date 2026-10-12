// Phone upload page: shrink the photo in the browser, post it with the caption,
// and list recent sends with their "seen on the TV" state.
const MAX_LONG = 1920;
const MAX_SHORT = 1080;
const $ = (id) => document.getElementById(id);
let shrunk = null; // Blob ready to send

const timeFmt = new Intl.DateTimeFormat("fr-CA", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

// Upright (EXIF orientation), at most 1080×1920 (either way round), JPEG.
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const long = Math.max(bmp.width, bmp.height);
  const short = Math.min(bmp.width, bmp.height);
  const scale = Math.min(1, MAX_LONG / long, MAX_SHORT / short);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", 0.85));
}

function setStatus(msg, kind = "") {
  $("status").textContent = msg;
  $("status").className = `status ${kind}`;
}

$("file").addEventListener("change", async () => {
  const file = $("file").files[0];
  shrunk = null;
  $("send").disabled = true;
  if (!file) return;
  setStatus("Préparation de la photo…");
  try {
    shrunk = await shrink(file);
    $("preview").src = URL.createObjectURL(shrunk);
    $("preview").hidden = false;
    $("pick").classList.add("has-photo");
    $("send").disabled = false;
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus("Impossible de lire cette photo.", "err");
  }
});

$("text").addEventListener("input", () => {
  $("count").textContent = Array.from($("text").value).length;
});

const ERRORS = {
  photo_type: "Format non pris en charge (JPEG, PNG ou WebP).",
  photo_too_big: "Photo trop lourde (2 Mo max).",
  text_too_long: "Message trop long (200 caractères max).",
  forbidden: "Session expirée : rechargez la page.",
};

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!shrunk) return;
  $("send").disabled = true;
  setStatus("Envoi…");
  const form = new FormData();
  form.append("photo", new File([shrunk], "photo.jpg", { type: "image/jpeg" }));
  form.append("text", $("text").value.trim());
  try {
    const res = await fetch("/api/messages", { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(ERRORS[body.error] || `Erreur ${res.status}`);
    }
    setStatus("Envoyé ! La photo apparaîtra sur la TV d'ici une minute.", "ok");
    $("form").reset();
    $("count").textContent = "0";
    $("preview").hidden = true;
    $("pick").classList.remove("has-photo");
    shrunk = null;
    loadHistory();
  } catch (err) {
    setStatus(err.message, "err");
    $("send").disabled = false;
  }
});

async function loadHistory() {
  const res = await fetch("/api/messages", { cache: "no-store" });
  if (!res.ok) return;
  const { messages } = await res.json();
  $("history").replaceChildren(...messages.map((m) => {
    const li = document.createElement("li");
    const img = document.createElement("img");
    img.src = `/api/photo/${m.id}`;
    img.loading = "lazy";
    img.alt = "";
    const info = document.createElement("div");
    const text = document.createElement("div");
    text.textContent = m.text || "(sans texte)";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${m.author} · ${timeFmt.format(m.createdAt)} · ` +
      (m.seenAt ? `Vue le ${timeFmt.format(m.seenAt)}` : "En attente");
    info.append(text, meta);
    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "Supprimer";
    del.addEventListener("click", async () => {
      if (!confirm("Supprimer cette photo ?")) return;
      const r = await fetch(`/api/messages/${m.id}`, { method: "DELETE" });
      if (r.ok) loadHistory();
    });
    li.append(img, info, del);
    return li;
  }));
}

loadHistory();
