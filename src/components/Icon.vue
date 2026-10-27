<script setup lang="ts">
defineProps<{ name: IconName; size?: number; stroke?: number }>();
export type IconName =
  | "close"
  | "gallery"
  | "flip"
  | "flash"
  | "flash-off"
  | "auto"
  | "check"
  | "trash"
  | "back"
  | "crop"
  | "pdf"
  | "plus"
  | "image"
  | "camera"
  | "sparkle"
  | "rotate"
  | "share"
  | "text"
  | "copy"
  | "grip";
</script>

<template>
  <svg
    :width="size ?? 22"
    :height="size ?? 22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="stroke ?? 1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'close'">
      <path d="M6 6l12 12M18 6L6 18" />
    </template>
    <template v-else-if="name === 'gallery'">
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <circle cx="8.5" cy="10" r="1.6" />
      <path d="M4 17l4.2-4.2a2 2 0 0 1 2.8 0L17 18.8" />
    </template>
    <template v-else-if="name === 'flip'">
      <path d="M20 11a8 8 0 0 0-13.6-4.9L4 8" />
      <path d="M4 5v3.4h3.4" />
      <path d="M4 13a8 8 0 0 0 13.6 4.9L20 16" />
      <path d="M20 19v-3.4h-3.4" />
    </template>
    <template v-else-if="name === 'flash'">
      <path d="M13 2L4.5 13.2h6L11 22l8.5-11.2h-6L13 2z" />
    </template>
    <template v-else-if="name === 'flash-off'">
      <path d="M13 2L4.5 13.2h6L11 22l8.5-11.2h-6L13 2z" />
      <path d="M3 3l18 18" />
    </template>
    <template v-else-if="name === 'auto'">
      <path d="M4 8V6a2 2 0 0 1 2-2h2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v2" />
      <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
      <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M12 8.5l1.3 2.9 2.9 1.3-2.9 1.3L12 16.9l-1.3-2.9L7.8 12.7l2.9-1.3L12 8.5z" />
    </template>
    <template v-else-if="name === 'sparkle'">
      <path d="M12 3l1.6 4.6L18 9.2l-4.4 1.6L12 15.4l-1.6-4.6L6 9.2l4.4-1.6L12 3z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="M5 12.5l4.5 4.5L19 6.5" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4 7h16" />
      <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
      <path d="M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2A1.6 1.6 0 0 0 16.7 19l.8-12" />
      <path d="M10.5 11v5.5M13.5 11v5.5" />
    </template>
    <template v-else-if="name === 'back'">
      <path d="M14.5 5L8 12l6.5 7" />
    </template>
    <template v-else-if="name === 'crop'">
      <path d="M6 3v13.5A1.5 1.5 0 0 0 7.5 18H21" />
      <path d="M3 6h13.5A1.5 1.5 0 0 1 18 7.5V21" />
    </template>
    <template v-else-if="name === 'pdf'">
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
      <path d="M9.5 16.5v-4h1.6a1.2 1.2 0 0 1 0 2.4H9.5" />
    </template>
    <template v-else-if="name === 'image'">
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M4 17l4.2-4.2a2 2 0 0 1 2.8 0L17 18.8" />
      <path d="M14 9h4" />
    </template>
    <template v-else-if="name === 'camera'">
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7l1-1.6A1.5 1.5 0 0 1 9.5 3.7h5a1.5 1.5 0 0 1 1.3.7l1 1.6h1.7A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-8z" />
      <circle cx="12" cy="12.4" r="3.4" />
    </template>
    <template v-else-if="name === 'rotate'">
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4.4V9h-4.6" />
    </template>
    <template v-else-if="name === 'share'">
      <path d="M12 15.5V4" />
      <path d="M8.4 7.6L12 4l3.6 3.6" />
      <path d="M5 13.5v5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-5" />
    </template>
    <template v-else-if="name === 'grip'">
      <circle cx="9.5" cy="7" r="1.25" />
      <circle cx="14.5" cy="7" r="1.25" />
      <circle cx="9.5" cy="12" r="1.25" />
      <circle cx="14.5" cy="12" r="1.25" />
      <circle cx="9.5" cy="17" r="1.25" />
      <circle cx="14.5" cy="17" r="1.25" />
    </template>
    <template v-else-if="name === 'text'">
      <path d="M5 6h14" />
      <path d="M5 10.7h14" />
      <path d="M5 15.4h9" />
      <path d="M5 20h5.5" />
    </template>
    <template v-else-if="name === 'copy'">
      <rect x="9" y="9" width="11" height="11" rx="2.4" />
      <path d="M15 6.2A2.2 2.2 0 0 0 12.8 4H6.2A2.2 2.2 0 0 0 4 6.2v6.6A2.2 2.2 0 0 0 6.2 15" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
  </svg>
</template>
