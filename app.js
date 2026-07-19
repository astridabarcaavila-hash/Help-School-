"use strict";

const CONFIG = window.HELP_SCHOOL_CONFIG || {};
const BASE_STORAGE_KEY = "helpSchoolV52";
const LAST_PROFILE_KEY = "helpSchoolLastStudentV52";
const API_BASE = String(CONFIG.NOVA_API_BASE || "/api").trim().replace(/\/$/, "");
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const clone = value => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const nowISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const defaultState = {
  user: null,
  bodyWeight: "",
  tasks: [],
  events: [],
  items: [],
  notifications: [],
  reminderLog: [],
  unlockedAchievements: [],
  meta: { clientUpdatedAt: 0 },
  chat: [{ id: uid(), role: "bot", text: "¡Hola! Soy NOVA. Dime qué curso estudias y qué necesitas comprender. Te ayudaré paso a paso.", createdAt: Date.now() }]
};

let state = clone(defaultState);
let activeTaskFilter = "all";
let deferredInstallPrompt = null;
let serviceWorkerRegistration = null;
let reloadingForUpdate = false;
let novaOnline = false;
let novaBusy = false;
let recognition = null;
let recognitionTarget = null;
let currentLocalUserId = "";

function storageKey(userId = "anonymous") {
  return `${BASE_STORAGE_KEY}:${userId}`;
}

function normalizeState(saved) {
  const merged = { ...clone(defaultState), ...(saved || {}) };
  merged.tasks = Array.isArray(merged.tasks) ? merged.tasks : [];
  merged.events = Array.isArray(merged.events) ? merged.events : [];
  merged.items = Array.isArray(merged.items) ? merged.items : [];
  merged.notifications = Array.isArray(merged.notifications) ? merged.notifications : [];
  merged.reminderLog = Array.isArray(merged.reminderLog) ? merged.reminderLog : [];
  merged.unlockedAchievements = Array.isArray(merged.unlockedAchievements) ? merged.unlockedAchievements : [];
  merged.meta = { clientUpdatedAt: 0, ...(merged.meta || {}) };
  merged.chat = Array.isArray(merged.chat) && merged.chat.length
    ? merged.chat.map(message => ({ id: message.id || uid(), createdAt: message.createdAt || Date.now(), ...message }))
    : clone(defaultState.chat);
  return merged;
}

function loadLocalState(userId) {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(storageKey(userId)) || "null"));
  } catch (error) {
    console.warn("No se pudo recuperar la información guardada.", error);
    return clone(defaultState);
  }
}

function saveState() {
  if (!state.meta) state.meta = {};
  state.meta.clientUpdatedAt = Date.now();
  const userId = currentLocalUserId || state.user?.uid || "anonymous";
  localStorage.setItem(storageKey(userId), JSON.stringify(state));
  updateAppBadge();
}

function normalizeIdentityText(value = "") {
  return String(value).trim().replace(/\s+/g, " ");
}

function studentId(firstNames, lastNames, level) {
  const source = `${normalizeIdentityText(firstNames)}|${normalizeIdentityText(lastNames)}|${normalizeIdentityText(level)}`
    .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `student-${(hash >>> 0).toString(36)}`;
}

function readLastProfile() {
  try {
    return JSON.parse(localStorage.getItem(LAST_PROFILE_KEY) || "null");
  } catch {
    return null;
  }
}

function rememberProfile(profile) {
  localStorage.setItem(LAST_PROFILE_KEY, JSON.stringify({
    firstNames: profile.firstNames,
    lastNames: profile.lastNames,
    level: profile.level
  }));
}

function showLogin(message = "") {
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
  const errorBox = $("#loginError");
  errorBox.textContent = message;
  errorBox.classList.toggle("hidden", !message);
  const saved = readLastProfile();
  if (saved) {
    $("#loginFirstNames").value = saved.firstNames || "";
    $("#loginLastNames").value = saved.lastNames || "";
    $("#loginLevel").value = saved.level || "";
  }
  setTimeout(() => $("#loginFirstNames")?.focus(), 80);
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function initials(name = "HELP SCHOOL") {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "HS";
}

function formatDate(dateString, options = { day: "numeric", month: "short" }) {
  if (!dateString) return "Sin fecha";
  return new Intl.DateTimeFormat("es-PE", options).format(new Date(`${dateString}T12:00:00`));
}

function formatNotificationTime(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat("es-PE", sameDay ? { hour: "numeric", minute: "2-digit" } : { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2500);
}


function isStandaloneMode() {
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIOSDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function updateInstallUI() {
  const installed = isStandaloneMode();
  document.documentElement.classList.toggle("standalone-mode", installed);
  const installButtons = [$("#installButton"), $("#installButtonHome"), $("#installButtonLogin")].filter(Boolean);
  installButtons.forEach(button => {
    button.classList.toggle("hidden", installed);
    button.disabled = installed;
  });
  $("#installCallout")?.classList.toggle("hidden", installed);
  const stateText = $("#installStateText");
  if (stateText) {
    stateText.textContent = installed
      ? "HELP SCHOOL ya está instalada en este dispositivo."
      : isIOSDevice()
        ? "En iPhone o iPad la instalación se realiza desde Safari usando Compartir → Agregar a inicio."
        : deferredInstallPrompt
          ? "Tu dispositivo está listo para instalar HELP SCHOOL."
          : "Abre esta página con Chrome o Safari desde una dirección HTTPS para instalarla.";
  }
  $("#installAppNow")?.classList.toggle("hidden", installed);
}

function openInstallGuide() {
  updateInstallUI();
  const dialog = $("#installGuideModal");
  if (dialog && !dialog.open) dialog.showModal();
}

async function triggerInstall() {
  if (isStandaloneMode()) {
    toast("HELP SCHOOL ya está instalada");
    return;
  }
  if (!deferredInstallPrompt) {
    openInstallGuide();
    return;
  }
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  updateInstallUI();
  if (choice.outcome === "accepted") toast("Instalando HELP SCHOOL…");
  else openInstallGuide();
}

function updateConnectionUI() {
  const online = navigator.onLine;
  $("#connectionBanner")?.classList.toggle("hidden", online);
  document.documentElement.classList.toggle("offline-mode", !online);
  if (online && state.user?.profileComplete) checkNovaHealth();
}

function showUpdateAvailable(registration) {
  serviceWorkerRegistration = registration || serviceWorkerRegistration;
  $("#updateBanner")?.classList.remove("hidden");
}

function showApp() {
  if (!state.user?.profileComplete) return showLogin("Completa tus nombres, apellidos y nivel para ingresar.");
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  renderAll();
  checkDueReminders();
  checkNovaHealth();
  updateNotificationPermissionUI();
  updateInstallUI();
  const params = new URLSearchParams(location.search);
  const requestedPage = params.get("page");
  if (["home", "tasks", "calendar", "backpack", "achievements", "nova", "profile"].includes(requestedPage)) navigate(requestedPage);
  if (params.get("action") === "new-task") {
    navigate("tasks");
    setTimeout(() => $("#taskModal")?.showModal(), 120);
  }
}

function navigate(page) {
  $$(".page").forEach(section => section.classList.toggle("active", section.dataset.page === page));
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.pageTarget === page));
  history.replaceState(null, "", page === "home" ? location.pathname : `${location.pathname}?page=${encodeURIComponent(page)}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (page === "profile") renderProfile();
  if (page === "nova") setTimeout(() => $("#novaQuestion")?.focus(), 100);
}

function renderAll() {
  renderHeader();
  renderTasks();
  renderEvents();
  renderItems();
  renderAchievements();
  renderDashboard();
  renderChat();
  renderProfile();
  renderNotifications();
  updateNotificationPermissionUI();
}

function renderHeader() {
  const now = new Date();
  $("#todayLabel").textContent = new Intl.DateTimeFormat("es-PE", { weekday: "long", day: "numeric", month: "long" }).format(now);
  $("#greeting").textContent = `Hola, ${state.user?.name || "estudiante"}`;
  $("#avatarButton").textContent = initials(state.user?.name);
}

function taskStats() {
  const total = state.tasks.length;
  const completed = state.tasks.filter(task => task.done).length;
  return { total, completed, pending: total - completed, percent: total ? Math.round((completed / total) * 100) : 0 };
}

function upcomingEvents() {
  return [...state.events].filter(event => event.date >= nowISO()).sort((a, b) => `${a.date}${a.time || ""}`.localeCompare(`${b.date}${b.time || ""}`));
}

function totalWeight() {
  return state.items.reduce((sum, item) => sum + Number(item.weight || 0), 0);
}

function points() {
  return taskStats().completed * 20 + state.events.length * 5 + state.items.length * 3;
}

function renderDashboard() {
  const stats = taskStats();
  const weight = totalWeight();
  const events = upcomingEvents();
  $("#statPending").textContent = stats.pending;
  $("#statPoints").textContent = points();
  $("#statWeight").textContent = `${weight} g`;
  $("#statEvents").textContent = events.length;
  $("#progressPercent").textContent = `${stats.percent}%`;
  $("#progressRing").style.setProperty("--progress", `${stats.percent * 3.6}deg`);
  $("#heroTitle").textContent = stats.total === 0 ? "¡Empieza organizando tu semana!" : stats.percent === 100 ? "¡Completaste todas tus tareas!" : "¡Sigue avanzando hacia tus metas!";
  $("#heroText").textContent = stats.total === 0 ? "Agrega tu primera tarea y recibe recordatorios." : `Has completado ${stats.completed} de ${stats.total} tareas.`;

  const nearestTask = state.tasks.filter(task => !task.done).sort(sortTasks)[0];
  const novaCoachTitle = $("#novaCoachTitle");
  const novaCoachText = $("#novaCoachText");
  const novaCoachButton = $("#novaCoachButton");
  if (nearestTask) {
    novaCoachTitle.textContent = `Avancemos con ${nearestTask.subject}`;
    novaCoachText.textContent = `Tienes “${nearestTask.title}” para ${formatDate(nearestTask.date)}. Puedo ayudarte a crear un plan o resolver una duda.`;
    novaCoachButton.dataset.prompt = `Ayúdame a organizar la tarea “${nearestTask.title}” del curso ${nearestTask.subject}, que debo presentar el ${formatDate(nearestTask.date, { day: "numeric", month: "long" })}.`;
    novaCoachButton.textContent = "Pedir ayuda";
  } else {
    novaCoachTitle.textContent = "Estoy lista para ayudarte";
    novaCoachText.textContent = "Pregúntame una duda, organiza una tarea o practica para un examen.";
    novaCoachButton.dataset.prompt = "Ayúdame a organizar mi semana de estudio";
    novaCoachButton.textContent = "Conversar";
  }

  const dueTasks = state.tasks.filter(task => !task.done).sort(sortTasks).slice(0, 4);
  const agenda = [
    ...dueTasks.map(task => ({ type: "task", title: task.title, meta: `${task.subject} · ${formatDate(task.date)}${task.time ? ` · ${task.time}` : ""}`, date: task.date })),
    ...events.slice(0, 3).map(event => ({ type: "event", title: event.title, meta: `${formatDate(event.date)} · ${event.time || "Sin hora"}`, date: event.date }))
  ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);

  $("#homeAgenda").innerHTML = agenda.length ? agenda.map(item => `
    <article class="list-card">
      <span class="${item.type === "task" ? "tag" : "tag priority-high"}">${item.type === "task" ? "Tarea" : "Evento"}</span>
      <div class="item-content"><div class="item-title">${escapeHTML(item.title)}</div><div class="item-meta"><span>${escapeHTML(item.meta)}</span></div></div>
    </article>`).join("") : emptyState("☀", "Agenda libre", "No tienes actividades próximas registradas.");

  const permissionGranted = "Notification" in window && Notification.permission === "granted";
  $("#notificationCallout").classList.toggle("hidden", permissionGranted);
  updateAppBadge();
}

function sortTasks(a, b) {
  return Number(a.done) - Number(b.done) || String(a.date || "9999").localeCompare(String(b.date || "9999")) || String(a.time || "").localeCompare(String(b.time || ""));
}

function renderTasks() {
  const today = nowISO();
  const filtered = state.tasks.filter(task => activeTaskFilter === "all" || (activeTaskFilter === "done" ? task.done : !task.done));
  const sorted = [...filtered].sort(sortTasks);
  $("#taskList").innerHTML = sorted.length ? sorted.map(task => {
    const overdue = !task.done && task.date && task.date < today;
    const priorityText = { high: "Alta", medium: "Media", low: "Baja" }[task.priority] || "Media";
    return `<article class="list-card task-list-card ${task.done ? "done" : ""}">
      <button class="check-button" data-task-toggle="${task.id}" type="button" aria-label="${task.done ? "Marcar pendiente" : "Marcar completada"}">✓</button>
      <div class="item-content"><div class="item-title">${escapeHTML(task.title)}</div><div class="item-meta"><span class="tag">${escapeHTML(task.subject)}</span><span class="tag priority-${escapeHTML(task.priority || "medium")}">${priorityText}</span><span class="${overdue ? "overdue" : ""}">${overdue ? "Vencida · " : ""}${formatDate(task.date)}${task.time ? ` · ${escapeHTML(task.time)}` : ""}</span></div><button class="task-nova-button" data-task-nova="${task.id}" type="button">✦ Preguntar a NOVA</button></div>
      <button class="icon-delete" data-task-delete="${task.id}" type="button" aria-label="Eliminar tarea">×</button>
    </article>`;
  }).join("") : emptyState("✓", "No hay tareas aquí", "Agrega una tarea o cambia el filtro seleccionado.");
  renderDashboard();
  renderAchievements();
}

function renderEvents() {
  const now = new Date();
  $("#monthName").textContent = new Intl.DateTimeFormat("es-PE", { month: "long", year: "numeric" }).format(now);
  $("#monthDay").textContent = now.getDate();
  $("#monthWeekday").textContent = new Intl.DateTimeFormat("es-PE", { weekday: "long" }).format(now);
  const sorted = [...state.events].sort((a, b) => `${a.date}${a.time || ""}`.localeCompare(`${b.date}${b.time || ""}`));
  $("#eventList").innerHTML = sorted.length ? sorted.map(event => `<article class="timeline-card"><strong>${escapeHTML(event.title)}</strong><small>${formatDate(event.date, { weekday: "short", day: "numeric", month: "long" })} · ${escapeHTML(event.time || "Sin hora")}</small><button class="icon-delete" data-event-delete="${event.id}" type="button" aria-label="Eliminar evento">×</button></article>`).join("") : emptyState("▣", "Calendario vacío", "Agrega exámenes, exposiciones, entregas o reuniones.");
  renderDashboard();
}

function renderItems() {
  const total = totalWeight();
  $("#totalWeight").textContent = `${total} g`;
  $("#bodyWeight").value = state.bodyWeight || "";
  const bodyKg = Number(state.bodyWeight);
  const ratio = bodyKg ? total / (bodyKg * 1000) : 0;
  const card = $(".weight-card");
  card.classList.remove("warning", "danger");
  let message = "Agrega los útiles que llevarás.";
  if (total > 0 && !bodyKg) message = "Registra tu peso corporal para obtener una referencia.";
  if (bodyKg && ratio <= .10) message = "El peso registrado está dentro de una referencia moderada.";
  if (bodyKg && ratio > .10 && ratio <= .15) { message = "Revisa si puedes retirar materiales innecesarios."; card.classList.add("warning"); }
  if (bodyKg && ratio > .15) { message = "La mochila está muy pesada. Pide ayuda a un adulto."; card.classList.add("danger"); }
  $("#weightMessage").textContent = message;
  $("#itemList").innerHTML = state.items.length ? state.items.map(item => `<article class="list-card"><span class="tag priority-low">Útil</span><div class="item-content"><div class="item-title">${escapeHTML(item.name)}</div><div class="item-meta"><span>${Number(item.weight)} g</span></div></div><button class="icon-delete" data-item-delete="${item.id}" type="button" aria-label="Eliminar útil">×</button></article>`).join("") : emptyState("🎒", "Tu mochila está vacía", "Registra los útiles que llevarás para calcular el peso.");
  renderDashboard();
  renderAchievements();
}

function achievementData() {
  const stats = taskStats();
  return [
    { id: "first-task", icon: "✓", name: "Primer paso", description: "Crear una tarea", unlocked: state.tasks.length >= 1 },
    { id: "three-done", icon: "★", name: "Responsable", description: "Completar 3 tareas", unlocked: stats.completed >= 3 },
    { id: "ten-done", icon: "⚡", name: "Imparable", description: "Completar 10 tareas", unlocked: stats.completed >= 10 },
    { id: "planner", icon: "▣", name: "Planificador", description: "Registrar 3 eventos", unlocked: state.events.length >= 3 },
    { id: "bag-ready", icon: "🎒", name: "Mochila lista", description: "Registrar 5 útiles", unlocked: state.items.length >= 5 },
    { id: "perfect", icon: "100", name: "Semana perfecta", description: "Completar todas", unlocked: stats.total >= 3 && stats.percent === 100 }
  ];
}

function renderAchievements() {
  $("#pointsTotal").textContent = points();
  $("#achievementGrid").innerHTML = achievementData().map(item => `<article class="achievement ${item.unlocked ? "" : "locked"}"><div class="achievement-icon">${item.icon}</div><strong>${item.name}</strong><small>${item.description}</small></article>`).join("");
}

function checkNewAchievements() {
  for (const achievement of achievementData().filter(item => item.unlocked)) {
    if (!state.unlockedAchievements.includes(achievement.id)) {
      state.unlockedAchievements.push(achievement.id);
      addNotification("🏆", "¡Nuevo logro!", `${achievement.name}: ${achievement.description}`, "achievements", true);
    }
  }
  saveState();
}

function renderProfile() {
  if (!state.user) return;
  $("#profileAvatar").textContent = initials(state.user.name);
  $("#profileName").textContent = state.user.name;
  $("#profileLevel").textContent = state.user.level || "Nivel no indicado";
  $("#profileFirstNamesInput").value = state.user.firstNames || "";
  $("#profileLastNamesInput").value = state.user.lastNames || "";
  $("#profileLevelInput").value = state.user.level || "Secundaria";
  updateNovaStatus();
}

function emptyState(icon, title, text) {
  return `<div class="empty-state"><span>${icon}</span><strong>${title}</strong><small>${text}</small></div>`;
}

// ---------------- NOTIFICACIONES ----------------
function notificationSupported() {
  return "Notification" in window && "serviceWorker" in navigator;
}

async function requestNotifications() {
  if (!notificationSupported()) {
    toast("Este navegador no permite notificaciones del sistema.");
    return false;
  }
  const permission = await Notification.requestPermission();
  updateNotificationPermissionUI();
  if (permission === "granted") {
    toast("Notificaciones activadas");
    addNotification("🔔", "Avisos activados", "HELP SCHOOL podrá mostrarte recordatorios en este dispositivo.", "home", true);
    return true;
  }
  toast(permission === "denied" ? "Los avisos fueron bloqueados en el navegador" : "No se activaron los avisos");
  return false;
}

function updateNotificationPermissionUI() {
  const supported = notificationSupported();
  const permission = supported ? Notification.permission : "unsupported";
  const labels = { granted: "Activadas", denied: "Bloqueadas por el navegador", default: "No activadas", unsupported: "No compatibles" };
  $("#notificationPermissionText").textContent = labels[permission] || "No activadas";
  ["#enableNotificationsHome", "#enableNotificationsProfile", "#enableNotificationsPanel"].forEach(selector => {
    const button = $(selector);
    if (!button) return;
    button.textContent = permission === "granted" ? "Activadas ✓" : permission === "denied" ? "Revisar permisos" : "Activar";
    button.disabled = permission === "granted";
  });
  $("#notificationCallout")?.classList.toggle("hidden", permission === "granted");
}

async function showSystemNotification(title, body, page = "home") {
  if (!notificationSupported() || Notification.permission !== "granted") return;
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, {
      body,
      icon: "icons/icon-192.png",
      badge: "icons/badge-96.png",
      tag: `help-school-${page}-${title}`,
      renotify: false,
      data: { url: `./?page=${page}` }
    });
  } catch (error) {
    console.warn("No se pudo mostrar el aviso.", error);
  }
}

function addNotification(icon, title, body, page = "home", system = false) {
  state.notifications.unshift({ id: uid(), icon, title, body, page, read: false, createdAt: Date.now() });
  state.notifications = state.notifications.slice(0, 60);
  saveState();
  renderNotifications();
  if (system) showSystemNotification(title, body, page);
}

function renderNotifications() {
  const unread = state.notifications.filter(item => !item.read).length;
  $("#notificationBadge").textContent = unread > 99 ? "99+" : String(unread);
  $("#notificationBadge").classList.toggle("hidden", unread === 0);
  $("#notificationList").innerHTML = state.notifications.length ? state.notifications.map(item => `<button class="notification-item ${item.read ? "" : "unread"}" data-notification-open="${item.id}" type="button"><span>${escapeHTML(item.icon)}</span><div><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.body)}</p><small>${formatNotificationTime(item.createdAt)}</small></div></button>`).join("") : emptyState("🔔", "Sin notificaciones", "Aquí aparecerán los avisos de tareas, eventos y logros.");
}

function datePlusDays(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function checkDueReminders() {
  const today = datePlusDays(0);
  const tomorrow = datePlusDays(1);
  for (const task of state.tasks.filter(item => !item.done && item.date)) {
    let body = "";
    let keyType = "";
    if (task.date < today) { body = `La tarea “${task.title}” está vencida.`; keyType = "overdue"; }
    else if (task.date === today) { body = `“${task.title}” vence hoy${task.time ? ` a las ${task.time}` : ""}.`; keyType = "today"; }
    else if (task.date === tomorrow) { body = `“${task.title}” vence mañana${task.time ? ` a las ${task.time}` : ""}.`; keyType = "tomorrow"; }
    if (!body) continue;
    const key = `${today}:${task.id}:${keyType}`;
    if (!state.reminderLog.includes(key)) {
      state.reminderLog.push(key);
      addNotification("⏰", "Recordatorio de tarea", body, "tasks", true);
    }
  }
  state.reminderLog = state.reminderLog.slice(-150);
  saveState();
}

function updateAppBadge() {
  const pending = state.tasks.filter(task => !task.done).length;
  if ("setAppBadge" in navigator) {
    (pending ? navigator.setAppBadge(pending) : navigator.clearAppBadge()).catch(() => {});
  }
}

// ---------------- NOVA Y SEGURIDAD ----------------
function safetyResponse(question) {
  const q = question.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const selfHarm = /(quiero|voy a|como puedo|ayudame a|pienso en).{0,28}(matarme|suicidarme|quitarme la vida|hacerme dano|cortarme)|no quiero vivir|seria mejor morir/.test(q);
  const immediateDanger = /(me estan pegando|me quieren matar|estoy en peligro|me estan abusando|me amenazan)/.test(q);
  const harmfulInstructions = /(como|pasos|instrucciones|ensename|ayudame).{0,35}(fabricar|hacer|usar|conseguir|ocultar).{0,25}(bomba|explosivo|arma|veneno|droga|metanfetamina)|como (matar|herir|lastimar|acosar|humillar|secuestrar)/.test(q);
  const cyberCrime = /(como|pasos|ayudame|ensename).{0,30}(hackear|robar contrasena|entrar a una cuenta|sacar datos privados|doxear|infectar con virus)/.test(q);
  const explicitSexual = /(como|quiero|ensename|manda).{0,25}(tener sexo|pornografia|foto desnuda|nudes|contenido sexual explicito)/.test(q);
  const dangerousDrugs = /(como|pasos|receta).{0,30}(preparar|fabricar|consumir|vender).{0,20}(cocaina|marihuana|droga|pastillas)/.test(q);
  const eatingHarm = /(como|quiero|ayudame).{0,30}(dejar de comer|vomitar para adelgazar|bajar de peso sin comer)/.test(q);

  if (selfHarm) return { blocked: true, type: "crisis", text: "Siento mucho que estés pasando por esto. Tu seguridad es lo más importante. No puedo ayudarte a hacerte daño. Busca ahora mismo a un adulto de confianza —familiar, docente, tutor o psicólogo— y no te quedes a solas. Si existe peligro inmediato en Perú, llama a la Policía 105 o a Bomberos 116. Si hay violencia familiar, también puedes llamar gratuitamente a la Línea 100. NOVA puede quedarse contigo para ayudarte a escribir un mensaje pidiendo ayuda." };
  if (immediateDanger) return { blocked: true, type: "danger", text: "Lo que describes puede ser una emergencia. Aléjate del peligro si puedes y avisa inmediatamente a un adulto de confianza. En Perú puedes llamar a la Policía 105, Bomberos 116 o Línea 100 ante violencia familiar. No compartas tu ubicación exacta ni datos personales en el chat." };
  if (harmfulInstructions || cyberCrime || explicitSexual || dangerousDrugs || eatingHarm) return { blocked: true, type: "blocked", text: "No puedo dar instrucciones que puedan dañar a una persona, vulnerar su privacidad o poner en riesgo tu bienestar. Sí puedo ayudarte con una explicación educativa y segura, prevención, convivencia, ciudadanía digital o cómo pedir apoyo a un adulto." };
  return { blocked: false };
}

function localNovaAnswer(question) {
  const safety = safetyResponse(question);
  if (safety.blocked) return safety.text;
  const q = question.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const level = state.user?.level || "Secundaria";

  if (/hola|buenos dias|buenas tardes|buenas noches/.test(q)) {
    return `¡Hola, ${state.user?.firstNames || "estudiante"}! Soy NOVA. Puedo explicar temas, ayudarte a organizar tareas, crear ejercicios de práctica y acompañarte para estudiar. ¿Qué curso y qué tema estás trabajando?`;
  }
  if (/mis tareas|tareas pendientes|organizar mis tareas/.test(q)) {
    const pending = state.tasks.filter(task => !task.done).sort(sortTasks).slice(0, 5);
    if (!pending.length) return "No tienes tareas pendientes registradas. Puedes agregar una desde la sección Tareas y luego pedirme un plan de trabajo.";
    const lines = pending.map((task, index) => `${index + 1}. ${task.title} — ${task.subject}, ${formatDate(task.date)}${task.time ? ` a las ${task.time}` : ""}.`);
    return `Estas son tus próximas tareas:\n${lines.join("\n")}\n\nEmpieza por la más cercana. Trabaja 20 minutos, descansa 5 y registra tu avance. Dime cuál deseas preparar primero.`;
  }
  if (/excel|funcion suma|formula suma|hoja de calculo/.test(q)) {
    return "En Excel, la función SUMA sirve para añadir varios valores automáticamente.\n\nEjemplo: si los números están desde A2 hasta A6, escribe:\n=SUMA(A2:A6)\n\nLuego presiona Enter. Los dos puntos significan «desde A2 hasta A6». Para practicar, dime qué celdas contiene tu tabla.";
  }
  if (/lean canvas/.test(q)) {
    return "El Lean Canvas organiza una idea de negocio en 9 bloques: segmento de clientes, problema, propuesta de valor, solución, canales, ingresos, costos, métricas clave y ventaja diferencial.\n\nPara empezar, responde: ¿quién tiene el problema y qué dificultad concreta quieres resolver?";
  }
  if (/usb booteable|memoria booteable|sistema operativo|boot menu/.test(q)) {
    return "Una memoria USB booteable contiene archivos preparados para iniciar una computadora e instalar o reparar un sistema operativo. El proceso general es: descargar la imagen ISO oficial, usar una herramienta de creación, elegir la USB, grabarla y arrancar la PC desde el Boot Menu. Antes de hacerlo, se debe respaldar la información porque la USB se formatea.";
  }
  if (/fraccion|fracciones/.test(q)) {
    return "Una fracción representa partes de un todo. El número superior es el numerador y señala cuántas partes tomamos; el inferior es el denominador y señala en cuántas partes iguales se dividió el total.\n\nEjemplo: 3/4 significa tomar 3 partes de un total dividido en 4 partes iguales. ¿Necesitas sumar, restar, multiplicar o comparar fracciones?";
  }
  if (/ecuacion|matemat|problema|calcular/.test(q)) {
    return "Escribe el ejercicio completo. Lo trabajaremos así: 1) identificamos los datos, 2) elegimos la operación o fórmula, 3) resolvemos paso a paso y 4) comprobamos el resultado. No te daré solo la respuesta: te ayudaré a comprender el procedimiento.";
  }
  if (/examen|estudiar|memorizar|repasar|practicar/.test(q)) {
    return `Plan de estudio para nivel ${level}:\n1. Escribe los temas que entrarán.\n2. Estudia uno durante 20–25 minutos.\n3. Explícalo con tus propias palabras.\n4. Responde 3 preguntas sin mirar.\n5. Corrige tus errores y repasa.\n\nDime el curso y el tema para prepararte preguntas.`;
  }
  if (/tarea|trabajo|proyecto|exposicion/.test(q)) {
    return "Organicemos tu actividad:\n1. Copia la consigna exacta.\n2. Identifica qué producto debes entregar.\n3. Divide el trabajo en pasos pequeños.\n4. Coloca un tiempo para cada paso.\n5. Revisa usando los criterios del docente.\n\nEscribe el curso, la consigna y la fecha para darte un plan más preciso.";
  }
  if (/resumen|explica|tema|concepto|no entiendo|duda/.test(q)) {
    return "Escribe el nombre exacto del tema o pega el contenido que debes estudiar. Te responderé con: idea principal, explicación sencilla, ejemplo, puntos para memorizar y una pregunta de comprobación.";
  }
  if (/triste|ansioso|ansiosa|solo|sola|preocupado|preocupada|miedo/.test(q)) {
    return "Gracias por contarlo. No tienes que afrontar esto solo/a. Busca a un adulto de confianza, tu tutor o el psicólogo de la institución. Puedo ayudarte a ordenar lo que quieres decir o a redactar un mensaje para pedir apoyo, pero no reemplazo a un profesional.";
  }
  return "Para ayudarte mejor, dime: 1) curso, 2) tema o consigna, 3) qué parte no comprendes y 4) cuándo debes presentarlo. Ejemplo: «Estoy en secundaria y no entiendo cómo usar SUMA en Excel».";
}

function updateNovaStatus() {
  const status = $("#novaStatus");
  const backendText = $("#novaBackendText");
  const modalStatus = $("#novaModalStatus");
  if (novaOnline) {
    status.textContent = "IA conectada";
    status.className = "status-pill online";
    backendText.textContent = "NOVA está conectada al servidor seguro";
    if (modalStatus) modalStatus.textContent = "IA conectada · lista para ayudarte";
  } else {
    status.textContent = "Modo local";
    status.className = "status-pill offline";
    backendText.textContent = API_BASE ? "Servidor no disponible; orientación local activa" : "Falta configurar la URL del servidor";
    if (modalStatus) modalStatus.textContent = "Guía local · conecta el servidor para IA completa";
  }
}

async function checkNovaHealth(showToast = false) {
  if (!API_BASE) {
    novaOnline = false;
    updateNovaStatus();
    if (showToast) toast("Falta configurar NOVA_API_BASE en config.js");
    return false;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${API_BASE}/health`, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    const payload = await response.json().catch(() => ({}));
    novaOnline = response.ok && payload.configured === true;
  } catch {
    novaOnline = false;
  }
  updateNovaStatus();
  if (showToast) toast(novaOnline ? "NOVA está conectada" : "No se pudo conectar; se usará el modo local");
  return novaOnline;
}

function chatMessageHTML(message) {
  return `<div class="message-wrap ${message.role === "user" ? "user" : "bot"}"><div class="bubble ${message.role === "user" ? "user" : "bot"}">${escapeHTML(message.text)}</div>${message.role === "bot" ? `<div class="message-actions"><button class="message-action" data-speak="${message.id}" type="button" aria-label="Escuchar respuesta">🔊</button><button class="message-action" data-copy-message="${message.id}" type="button" aria-label="Copiar respuesta">📋</button></div>` : ""}</div>`;
}

function renderChat() {
  const html = state.chat.map(chatMessageHTML).join("");
  [$("#chatList"), $("#novaModalChatList")].filter(Boolean).forEach(container => {
    container.innerHTML = html;
    requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
  });
}

function showTyping(show) {
  [$("#chatList"), $("#novaModalChatList")].filter(Boolean).forEach(container => {
    container.querySelector("[data-nova-typing]")?.remove();
    if (!show) return;
    container.insertAdjacentHTML("beforeend", `<div data-nova-typing class="message-wrap bot"><div class="bubble bot"><span class="typing"><i></i><i></i><i></i></span></div></div>`);
    container.scrollTop = container.scrollHeight;
  });
}

function setNovaBusy(busy) {
  novaBusy = busy;
  $$("#novaForm button[type='submit'], #novaModalForm button[type='submit']").forEach(button => button.disabled = busy);
  $$("#novaQuestion, #novaModalQuestion").forEach(area => area.disabled = busy);
  $("#novaFab")?.classList.toggle("thinking", busy);
}

function openNovaChat(prefill = "") {
  const dialog = $("#novaChatModal");
  if (!dialog) return navigate("nova");
  renderChat();
  updateNovaStatus();
  if (!dialog.open) dialog.showModal();
  const area = $("#novaModalQuestion");
  if (prefill) area.value = prefill;
  autoResizeTextarea(area);
  setTimeout(() => area?.focus(), 100);
}

function clearNovaConversation() {
  state.chat = [{ id: uid(), role: "bot", text: `¡Hola, ${state.user?.firstNames || "estudiante"}! Empecemos una nueva conversación. ¿Qué necesitas aprender hoy?`, createdAt: Date.now() }];
  saveState();
  renderChat();
  toast("Conversación de NOVA reiniciada");
}


async function askNova(question) {
  if (novaBusy) return;
  const cleanQuestion = question.trim();
  if (!cleanQuestion) return;
  setNovaBusy(true);
  state.chat.push({ id: uid(), role: "user", text: cleanQuestion, createdAt: Date.now() });
  state.chat = state.chat.slice(-40);
  saveState();
  renderChat();
  showTyping(true);

  const safety = safetyResponse(cleanQuestion);
  let answer = "";
  if (safety.blocked) {
    answer = safety.text;
  } else if (novaOnline || await checkNovaHealth(false)) {
    try {
      const response = await fetch(`${API_BASE}/nova`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: cleanQuestion,
          profile: { name: state.user?.firstNames || state.user?.name || "Estudiante", level: state.user?.level || "Secundaria", locale: "es-PE" },
          context: { pendingTasks: state.tasks.filter(task => !task.done).sort(sortTasks).slice(0, 5).map(({ title, subject, date, time }) => ({ title, subject, date, time })) },
          history: state.chat.slice(0, -1).slice(-10).map(({ role, text }) => ({ role, text }))
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "No se pudo obtener una respuesta");
      answer = payload.answer || localNovaAnswer(cleanQuestion);
    } catch (error) {
      console.warn(error);
      novaOnline = false;
      updateNovaStatus();
      answer = `${localNovaAnswer(cleanQuestion)}\n\n(Estoy usando el modo local porque el servidor de NOVA no respondió.)`;
    }
  } else {
    answer = localNovaAnswer(cleanQuestion);
  }

  showTyping(false);
  state.chat.push({ id: uid(), role: "bot", text: answer, createdAt: Date.now() });
  state.chat = state.chat.slice(-40);
  saveState();
  renderChat();
  setNovaBusy(false);
}

async function copyMessage(messageId) {
  const message = state.chat.find(item => item.id === messageId);
  if (!message) return;
  try {
    await navigator.clipboard.writeText(message.text);
    toast("Respuesta copiada");
  } catch {
    toast("No se pudo copiar la respuesta");
  }
}

function speakMessage(messageId) {
  const message = state.chat.find(item => item.id === messageId);
  if (!message || !("speechSynthesis" in window)) return toast("La lectura en voz alta no está disponible.");
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message.text);
  utterance.lang = "es-PE";
  utterance.rate = .95;
  speechSynthesis.speak(utterance);
}

function setupVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $("#voiceButton").classList.add("hidden");
    $("#novaModalVoiceButton")?.classList.add("hidden");
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = "es-PE";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    $("#voiceButton")?.classList.toggle("listening", recognitionTarget === $("#novaQuestion"));
    $("#novaModalVoiceButton")?.classList.toggle("listening", recognitionTarget === $("#novaModalQuestion"));
    toast("Te escucho…");
  };
  recognition.onend = () => {
    $("#voiceButton")?.classList.remove("listening");
    $("#novaModalVoiceButton")?.classList.remove("listening");
  };
  recognition.onerror = () => toast("No se pudo reconocer la voz");
  recognition.onresult = event => {
    const area = recognitionTarget || $("#novaQuestion");
    area.value = event.results[0][0].transcript;
    autoResizeTextarea(area);
    area.focus();
  };
}

function startVoiceInput(area) {
  if (!recognition) return toast("El dictado por voz no está disponible en este navegador");
  recognitionTarget = area;
  try { recognition.start(); } catch { recognition.stop(); }
}

function autoResizeTextarea(area = $("#novaQuestion")) {
  if (!area) return;
  area.style.height = "auto";
  area.style.height = `${Math.min(area.scrollHeight, 130)}px`;
}

// ---------------- MODALES Y EVENTOS ----------------
function setupModals() {
  $$('[data-modal]').forEach(button => button.addEventListener("click", () => {
    const dialog = document.getElementById(button.dataset.modal);
    dialog.showModal();
    setTimeout(() => dialog.querySelector("input")?.focus(), 70);
  }));
  $$(".close-modal").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  $$("dialog").forEach(dialog => dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  }));
}

$$('[data-page-target]').forEach(button => button.addEventListener("click", () => navigate(button.dataset.pageTarget)));
$$('[data-go]').forEach(button => button.addEventListener("click", () => navigate(button.dataset.go)));
$("#avatarButton").addEventListener("click", () => navigate("profile"));

$$('[data-task-filter]').forEach(button => button.addEventListener("click", () => {
  activeTaskFilter = button.dataset.taskFilter;
  $$('[data-task-filter]').forEach(item => item.classList.toggle("active", item === button));
  renderTasks();
}));

$("#taskForm").addEventListener("submit", event => {
  event.preventDefault();
  const task = { id: uid(), title: $("#taskTitle").value.trim(), subject: $("#taskSubject").value.trim(), date: $("#taskDate").value, time: $("#taskTime").value, priority: $("#taskPriority").value, done: false, createdAt: Date.now(), completedAt: null };
  state.tasks.push(task);
  saveState(); renderTasks(); $("#taskForm").reset(); $("#taskTime").value = "18:00"; $("#taskModal").close();
  addNotification("📝", "Tarea registrada", `${task.title} · ${formatDate(task.date)}${task.time ? ` a las ${task.time}` : ""}`, "tasks", true);
  checkNewAchievements(); toast("Tarea agregada");
});

$("#taskList").addEventListener("click", event => {
  const toggle = event.target.closest("[data-task-toggle]");
  const remove = event.target.closest("[data-task-delete]");
  const ask = event.target.closest("[data-task-nova]");
  if (toggle) {
    const task = state.tasks.find(item => item.id === toggle.dataset.taskToggle);
    if (task) {
      task.done = !task.done;
      task.completedAt = task.done ? Date.now() : null;
      saveState(); renderTasks();
      if (task.done) addNotification("✅", "¡Tarea completada!", `${task.title}. Ganaste 20 puntos.`, "tasks", true);
      else addNotification("↩️", "Tarea marcada como pendiente", task.title, "tasks", false);
      checkNewAchievements();
    }
  }
  if (ask) {
    const task = state.tasks.find(item => item.id === ask.dataset.taskNova);
    if (task) openNovaChat(`Necesito ayuda con la tarea “${task.title}” del curso ${task.subject}. Debo presentarla el ${formatDate(task.date, { day: "numeric", month: "long" })}. Ayúdame a entenderla y organizarla paso a paso.`);
  }
  if (remove) {
    const task = state.tasks.find(item => item.id === remove.dataset.taskDelete);
    state.tasks = state.tasks.filter(item => item.id !== remove.dataset.taskDelete);
    saveState(); renderTasks(); toast(task ? `Se eliminó “${task.title}”` : "Tarea eliminada");
  }
});

$("#eventForm").addEventListener("submit", event => {
  event.preventDefault();
  const item = { id: uid(), title: $("#eventTitle").value.trim(), date: $("#eventDate").value, time: $("#eventTime").value, createdAt: Date.now() };
  state.events.push(item);
  saveState(); renderEvents(); $("#eventForm").reset(); $("#eventTime").value = "08:00"; $("#eventModal").close();
  addNotification("📅", "Evento registrado", `${item.title} · ${formatDate(item.date)} a las ${item.time}`, "calendar", true);
  checkNewAchievements(); toast("Evento agregado");
});

$("#eventList").addEventListener("click", event => {
  const remove = event.target.closest("[data-event-delete]");
  if (!remove) return;
  state.events = state.events.filter(item => item.id !== remove.dataset.eventDelete);
  saveState(); renderEvents(); toast("Evento eliminado");
});

$("#itemForm").addEventListener("submit", event => {
  event.preventDefault();
  state.items.push({ id: uid(), name: $("#itemName").value.trim(), weight: Number($("#itemWeight").value), createdAt: Date.now() });
  saveState(); renderItems(); $("#itemForm").reset(); $("#itemModal").close(); checkNewAchievements(); toast("Útil agregado");
});

$("#itemList").addEventListener("click", event => {
  const remove = event.target.closest("[data-item-delete]");
  if (!remove) return;
  state.items = state.items.filter(item => item.id !== remove.dataset.itemDelete);
  saveState(); renderItems(); toast("Útil eliminado");
});

$("#bodyWeight").addEventListener("change", event => { state.bodyWeight = event.target.value; saveState(); renderItems(); });

$("#novaForm").addEventListener("submit", event => {
  event.preventDefault();
  const area = $("#novaQuestion");
  const question = area.value;
  area.value = "";
  autoResizeTextarea(area);
  askNova(question);
});

$("#novaModalForm").addEventListener("submit", event => {
  event.preventDefault();
  const area = $("#novaModalQuestion");
  const question = area.value;
  area.value = "";
  autoResizeTextarea(area);
  askNova(question);
});

[$("#novaQuestion"), $("#novaModalQuestion")].forEach(area => {
  area.addEventListener("input", () => autoResizeTextarea(area));
  area.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      area.closest("form").requestSubmit();
    }
  });
});

$$('[data-nova-prompt]').forEach(button => button.addEventListener("click", () => {
  const area = $("#novaQuestion");
  area.value = button.dataset.novaPrompt;
  autoResizeTextarea(area);
  $("#novaForm").requestSubmit();
}));

$$('[data-nova-modal-prompt]').forEach(button => button.addEventListener("click", () => {
  const area = $("#novaModalQuestion");
  area.value = button.dataset.novaModalPrompt;
  autoResizeTextarea(area);
  $("#novaModalForm").requestSubmit();
}));

[$("#chatList"), $("#novaModalChatList")].forEach(container => container.addEventListener("click", event => {
  const speak = event.target.closest("[data-speak]");
  const copy = event.target.closest("[data-copy-message]");
  if (speak) speakMessage(speak.dataset.speak);
  if (copy) copyMessage(copy.dataset.copyMessage);
}));

$("#voiceButton").addEventListener("click", () => startVoiceInput($("#novaQuestion")));
$("#novaModalVoiceButton").addEventListener("click", () => startVoiceInput($("#novaModalQuestion")));
$("#novaFab").addEventListener("click", () => openNovaChat());
$("#openNovaFloating").addEventListener("click", () => openNovaChat());
$("#novaCoachButton").addEventListener("click", event => openNovaChat(event.currentTarget.dataset.prompt || ""));
$("#expandNovaChat").addEventListener("click", () => { $("#novaChatModal").close(); navigate("nova"); });
$("#clearNovaChat").addEventListener("click", clearNovaConversation);

$("#profileForm").addEventListener("submit", event => {
  event.preventDefault();
  const firstNames = normalizeIdentityText($("#profileFirstNamesInput").value);
  const lastNames = normalizeIdentityText($("#profileLastNamesInput").value);
  const level = $("#profileLevelInput").value;
  if (!firstNames || !lastNames || !level) return toast("Completa nombres, apellidos y nivel");
  const previousUserId = currentLocalUserId || state.user?.uid || "";
  const nextUserId = studentId(firstNames, lastNames, level);
  state.user = {
    ...state.user,
    uid: nextUserId,
    firstNames,
    lastNames,
    name: `${firstNames} ${lastNames}`,
    level,
    profileComplete: true
  };
  currentLocalUserId = nextUserId;
  rememberProfile(state.user);
  saveState();
  if (previousUserId && previousUserId !== nextUserId) localStorage.removeItem(storageKey(previousUserId));
  renderHeader();
  renderProfile();
  toast("Perfil actualizado");
});

$("#logoutButton").addEventListener("click", () => {
  saveState();
  navigate("home");
  showLogin();
});

$("#notificationButton").addEventListener("click", () => { renderNotifications(); $("#notificationPanel").showModal(); });
$("#notificationList").addEventListener("click", event => {
  const button = event.target.closest("[data-notification-open]");
  if (!button) return;
  const notification = state.notifications.find(item => item.id === button.dataset.notificationOpen);
  if (!notification) return;
  notification.read = true;
  saveState(); renderNotifications(); $("#notificationPanel").close(); navigate(notification.page || "home");
});
$("#markNotificationsRead").addEventListener("click", () => { state.notifications.forEach(item => item.read = true); saveState(); renderNotifications(); });
["#enableNotificationsHome", "#enableNotificationsProfile", "#enableNotificationsPanel"].forEach(selector => $(selector).addEventListener("click", requestNotifications));
$("#testNovaButton").addEventListener("click", () => checkNovaHealth(true));

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallUI();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  updateInstallUI();
  $("#installGuideModal")?.open && $("#installGuideModal").close();
  toast("HELP SCHOOL se instaló correctamente");
});

window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", updateInstallUI);
["#installButton", "#installButtonHome", "#installButtonLogin", "#installAppNow"].forEach(selector => {
  $(selector)?.addEventListener("click", triggerInstall);
});

$("#reloadAppButton")?.addEventListener("click", () => {
  const waiting = serviceWorkerRegistration?.waiting;
  if (waiting) waiting.postMessage({ type: "SKIP_WAITING" });
  else location.reload();
});

window.addEventListener("online", updateConnectionUI);
window.addEventListener("offline", updateConnectionUI);
updateConnectionUI();
updateInstallUI();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./service-worker.js", { scope: "./" });
      serviceWorkerRegistration = registration;
      if (registration.waiting) showUpdateAvailable(registration);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdateAvailable(registration);
        });
      });
    } catch (error) {
      console.warn("No se pudo registrar el service worker.", error);
    }
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    location.reload();
  });
}

setupModals();
setupVoiceInput();
$("#taskDate").min = nowISO();
$("#eventDate").min = nowISO();
$("#taskDate").value = nowISO();
$("#eventDate").value = nowISO();
setInterval(checkDueReminders, 30 * 60 * 1000);

$("#localLoginForm").addEventListener("submit", event => {
  event.preventDefault();
  const firstNames = normalizeIdentityText($("#loginFirstNames").value);
  const lastNames = normalizeIdentityText($("#loginLastNames").value);
  const level = $("#loginLevel").value;
  const errorBox = $("#loginError");

  if (firstNames.length < 2 || lastNames.length < 2 || !level) {
    errorBox.textContent = "Completa correctamente tus nombres, apellidos y nivel educativo.";
    errorBox.classList.remove("hidden");
    return;
  }

  currentLocalUserId = studentId(firstNames, lastNames, level);
  state = loadLocalState(currentLocalUserId);
  state.user = {
    ...(state.user || {}),
    uid: currentLocalUserId,
    firstNames,
    lastNames,
    name: `${firstNames} ${lastNames}`,
    level,
    profileComplete: true
  };
  rememberProfile(state.user);
  saveState();
  errorBox.classList.add("hidden");
  showApp();
  toast(`Bienvenido, ${firstNames}`);
});

function initializeLocalAccess() {
  state = clone(defaultState);
  currentLocalUserId = "";
  showLogin();
}

initializeLocalAccess();
