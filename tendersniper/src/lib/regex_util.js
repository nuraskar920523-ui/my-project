function makeWordRegex(pattern) {
  return new RegExp('(?<![a-zа-яё0-9])(' + pattern + ')(?![a-zа-яё0-9])', 'i');
}
