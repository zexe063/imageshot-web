import type { Annotation, TextPreset } from './editor-types';

/** Installed system faces are the fallbacks for the bundled sans-serif fonts. */
export const TEXT_FAMILIES = ['Inter', 'Geist', 'Rounded', 'Monospaced'] as const;
export type TextFamily = (typeof TEXT_FAMILIES)[number];
const TEXT_STACKS: Record<TextFamily, string> = {
  Inter: '"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  Geist: '"Geist Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  Rounded: '"Arial Rounded MT Bold", "Trebuchet MS", ui-rounded, sans-serif',
  Monospaced: '"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
};

export const TEXT_PRESETS: ReadonlyArray<{ id: TextPreset; label: string; family: TextFamily; weight: number }> = [
  { id: 'standard', label: 'Standard', family: 'Inter', weight: 600 },
  { id: 'rounded', label: 'Rounded', family: 'Rounded', weight: 700 },
  { id: 'monospaced', label: 'Monospaced', family: 'Monospaced', weight: 700 },
  { id: 'outlined', label: 'Outlined', family: 'Inter', weight: 700 },
  { id: 'boxed', label: 'Boxed', family: 'Inter', weight: 700 },
  { id: 'rounded-boxed', label: 'Rounded Boxed', family: 'Rounded', weight: 700 },
  { id: 'monospaced-boxed', label: 'Monospaced Boxed', family: 'Monospaced', weight: 700 },
];

export function textPreset(value?: string) {
  return TEXT_PRESETS.find(preset => preset.id === value) ?? TEXT_PRESETS[0];
}

export function textStack(family?: string) {
  return TEXT_STACKS[family as TextFamily] ?? TEXT_STACKS.Inter;
}

/** Presets change the treatment and face, while keeping the user's size and ink. */
export function textPresetPatch(value: TextPreset): Partial<Annotation> {
  const preset = textPreset(value);
  return {
    textPreset: preset.id,
    fontFamily: preset.family,
    fontWeight: preset.weight,
    textBackground: preset.id === 'monospaced-boxed' ? '#ffffff' : '#e5e5e5',
    textOutline: '#ffffff',
  };
}

/** Measured in image pixels, so resizing text scales its box and outline too. */
export function textTreatment(annotation: Pick<Annotation, 'textPreset' | 'textBackground' | 'textOutline' | 'fontSize'>) {
  const preset = textPreset(annotation.textPreset);
  const size = Number.isFinite(annotation.fontSize) && annotation.fontSize! > 0 ? annotation.fontSize! : 28;
  const boxed = preset.id === 'boxed' || preset.id === 'rounded-boxed' || preset.id === 'monospaced-boxed';
  const outlineWidth = preset.id === 'outlined' ? Math.max(2, size * 0.16) : 0;
  const borderWidth = preset.id === 'monospaced-boxed' ? Math.max(1, size * 0.025) : 0;
  return {
    preset: preset.id,
    background: boxed ? annotation.textBackground ?? (preset.id === 'monospaced-boxed' ? '#ffffff' : '#e5e5e5') : null,
    outline: annotation.textOutline ?? '#ffffff',
    outlineWidth,
    borderWidth,
    borderColor: '#d4d4d8',
    paddingX: boxed ? size * (preset.id === 'rounded-boxed' ? 0.6 : 0.32) : outlineWidth / 2,
    paddingY: boxed ? size * 0.14 : outlineWidth / 2,
    radius: preset.id === 'rounded-boxed' ? Infinity : preset.id === 'boxed' ? size * 0.14 : 0,
  };
}
