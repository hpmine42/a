<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { exportPdf, pdfFilename, type PageFormat } from "../lib/pdf";
import { clearPages, removePage, scan } from "../lib/store";

const emit = defineEmits<{ (e: "back"): void; (e: "edit", id: number): void; (e: "add"): void }>();

const busy = ref(false);
const progress = ref({ done: 0, total: 0 });
const error = ref<string | null>(null);
const nameField = ref<HTMLInputElement | null>(null);

const isBusy = computed(() => busy.value);

const formats: { id: PageFormat; label: string; hint: string }[] = [
  { id: "a4", label: "A4", hint: "Print on A4, 4% margin" },
  { id: "letter", label: "Letter", hint: "US Letter, 4% margin" },
  { id: "fit", label: "Fit", hint: "Page matches the scan exactly" },
];
const label = computed(() => (scan.pages.length === 1 ? "1 page" : `${scan.pages.length} pages`));

/** A friendly default: "Scano 2026-10-26", editable before saving. */
function suggestedName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Scano ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

onMounted(() => {
  if (!scan.filename) scan.filename = suggestedName();
});

const finalName = computed(() => pdfFilename(scan.filename, scan.pages.length));

async function savePdf() {
  if (!scan.pages.length || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await exportPdf(scan.pages, scan.format, (done, total) => (progress.value = { done, total }), scan.filename);
  } catch (err) {
    console.error(err);
    error.value = "Export failed — try again.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="pages">
    <header class="pages-top">
      <button class="control" aria-label="Back to camera" @click="emit('back')">
        <Icon name="back" :size="19" />
        <span>Camera</span>
      </button>
      <span class="pages-count">{{ label }}</span>
      <button class="control danger" aria-label="Delete all pages" @click="clearPages()">
        <Icon name="trash" :size="18" />
        <span>Clear</span>
      </button>
    </header>

    <div class="pages-grid">
      <figure v-for="(page, i) in scan.pages" :key="page.id" class="page-card">
        <button class="page-thumb" :aria-label="`Edit page ${i + 1}`" @click="emit('edit', page.id)">
          <img v-if="page.thumb" :src="page.thumb" alt="" />
          <span class="page-num">{{ i + 1 }}</span>
        </button>
        <button class="page-del" :aria-label="`Remove page ${i + 1}`" @click="removePage(page.id)">
          <Icon name="close" :size="15" :stroke="2.2" />
        </button>
      </figure>

      <button class="page-add" aria-label="Add pages" @click="emit('add')">
        <Icon name="plus" :size="24" />
      </button>
    </div>

    <footer class="pages-dock">
      <label class="name-field" for="pdf-name">
        <span class="name-label">File name</span>
        <span class="name-input">
          <input
            id="pdf-name"
            ref="nameField"
            v-model="scan.filename"
            type="text"
            inputmode="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            maxlength="80"
            placeholder="Scano 2026-10-26"
            :aria-describedby="'pdf-name-hint'"
          />
          <span class="name-ext" aria-hidden="true">.pdf</span>
        </span>
      </label>
      <p id="pdf-name-hint" class="name-hint">
        Saves as <strong>{{ finalName }}</strong>
      </p>

      <div class="paper-row" role="group" aria-label="Paper size">
        <button
          v-for="option in formats"
          :key="option.id"
          class="paper"
          :class="{ active: scan.format === option.id }"
          :aria-pressed="scan.format === option.id"
          :title="option.hint"
          @click="scan.format = option.id"
        >
          {{ option.label }}
        </button>
      </div>
      <p v-if="error" class="pages-error">{{ error }}</p>
      <button class="save" :disabled="isBusy || !scan.pages.length" @click="savePdf">
        <Icon name="pdf" :size="19" />
        <span>{{ isBusy ? `Building ${progress.done}/${progress.total}…` : "Save PDF" }}</span>
      </button>
    </footer>
  </div>
</template>
