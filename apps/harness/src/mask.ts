export const MASK = "***";

export class SecretMask {
  private forms: string[] = [];

  register(value: string): void {
    if (value === "") {
      return;
    }
    const forms = new Set([...this.forms, value]);
    try {
      const encoded = encodeURIComponent(value);
      forms.add(encoded);
      forms.add(encoded.replaceAll("%20", "+"));
    } catch {
      // A value that cannot be URL-encoded has no encoded form to hide.
    }
    this.forms = [...forms].sort((left, right) => right.length - left.length);
  }

  apply(text: string): string {
    let masked = text;
    for (const form of this.forms) {
      masked = masked.replaceAll(form, MASK);
    }
    return masked;
  }
}
