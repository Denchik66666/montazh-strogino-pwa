/** См. montazh-pwa/ИНСТРУКЦИЯ-PWA.md */
window.APP_CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbz4cM7rc7QmZ6Bt85-2z92skYCmJlTJxOFG3xKiPjt-N-E6F4mrvQiwVwmHrPgpIw1IQw/exec",
  APP_NAME: "Den - Монтажник",
  /** Версия релиза (semver). Менять только когда готов новый раздел — см. VERSIONS.md. Не при каждой правке. */
  APP_VERSION: "1.1.0",
  /** Название строительной площадки (фиксируем, не берём из имени таблицы). */
  PROJECT_NAME: "СИН, кор 2 (11 сек)",
  MIN_METERS: 0,
  MAX_METERS: 500,
  PHOTOS_ENABLED: true,
  /** Макс. размер фото на Диске (МБ); больше — сжимаем автоматически */
  PHOTO_MAX_MB: 2,
  /** 1080p — длинная сторона не больше 1920 px */
  PHOTO_MAX_SIDE: 1920,
  /** Качество JPEG при сжатии (0–1) */
  PHOTO_JPEG_QUALITY: 0.85,
  /** Предупреждение, если файл меньше (КБ) — часто «Камера» в браузере даёт миниатюру */
  PHOTO_MIN_WARN_KB: 250,
  /** Макс. размер PDF РД при загрузке с телефона (МБ) */
  RD_MAX_MB: 30,
  /** Web Push — broadcast всей бригаде (нужны VAPID + push-server на Vercel) */
  PUSH_ENABLED: true,
  /** Публичный VAPID (тот же, что VAPID_PUBLIC в Config.gs) */
  PUSH_VAPID_PUBLIC:
    "BNVFAl72FgxAGFsMqKvK0GSKsMc3mGLZw8wOXz2hMMJbClZMZcxRaYzlF5ojTY4qxclApgQ3Rx8xGTky31CuM04",
};
