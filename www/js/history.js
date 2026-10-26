// Historique annuler / rétablir basé sur des instantanés du document.

export class History {
  constructor(app, max = 60) {
    this.app = app;
    this.max = max;
    this.undoStack = [];
    this.redoStack = [];
    this.baseLabel = 'Ouverture';
  }

  reset(label = 'Ouverture') {
    this.undoStack = [];
    this.redoStack = [];
    this.baseLabel = label;
    this.app.emit('history');
  }

  // À appeler AVANT de modifier le document.
  push(label) {
    this.app.flushPending?.(label);
    this.undoStack.push({ label, state: this.app.doc.snapshot() });
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack = [];
    this.app.emit('history');
  }

  // Annule le dernier push si l'opération n'a finalement rien changé.
  discardLast() {
    this.undoStack.pop();
    this.app.emit('history');
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    this.app.cancelPending?.();
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push({ label: e.label, state: this.app.doc.snapshot() });
    this.app.doc.restore(e.state);
    this.app.afterRestore(`Annulé : ${e.label}`);
  }

  redo() {
    this.app.cancelPending?.();
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push({ label: e.label, state: this.app.doc.snapshot() });
    this.app.doc.restore(e.state);
    this.app.afterRestore(`Rétabli : ${e.label}`);
  }

  // Va directement à une étape (0 = état d'origine).
  goTo(step) {
    while (this.undoStack.length > step) this.undo();
    while (this.undoStack.length < step && this.redoStack.length) this.redo();
  }
}
