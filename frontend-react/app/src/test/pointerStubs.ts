// jsdom no implementa captura de puntero ni scrollIntoView, que el Select de
// Radix usa al abrir el menú. Solo lo importan las pruebas que interactúan con
// Select; devuelve una función para restaurar los prototipos al terminar.
export function installPointerStubs(): () => void {
  const element = Element.prototype as unknown as Record<string, unknown>;
  const saved = {
    hasPointerCapture: element.hasPointerCapture,
    setPointerCapture: element.setPointerCapture,
    releasePointerCapture: element.releasePointerCapture,
    scrollIntoView: element.scrollIntoView,
  };
  element.hasPointerCapture = () => false;
  element.setPointerCapture = () => {};
  element.releasePointerCapture = () => {};
  element.scrollIntoView = () => {};
  return () => Object.assign(Element.prototype, saved);
}
