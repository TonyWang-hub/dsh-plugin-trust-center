/* DSH Plugin Trust Center — progressive filter enhancement.
 * Core content (the full plugin list and every detail page) works without this
 * script; it only hides/show already-rendered items based on the embedded
 * registry data in #trust-registry-data. No dependencies, no network. */
(function () {
  'use strict'

  var dataNode = document.getElementById('trust-registry-data')
  var list = document.getElementById('plugin-list')
  if (dataNode === null || list === null) return

  var data
  try {
    data = JSON.parse(dataNode.textContent)
  } catch (error) {
    return
  }
  var entries = data.entries
  if (!Array.isArray(entries)) return

  var items = new Map()
  var children = list.children
  for (var i = 0; i < children.length; i += 1) {
    var item = children[i]
    var slug = item.getAttribute('data-slug')
    if (slug !== null) items.set(slug, item)
  }

  var controls = {
    name: document.getElementById('filter-name'),
    category: document.getElementById('filter-category'),
    declaration: document.getElementById('filter-declaration'),
    verdict: document.getElementById('filter-verdict'),
    severity: document.getElementById('filter-severity'),
    source: document.getElementById('filter-source'),
    version: document.getElementById('filter-version'),
  }
  var reset = document.getElementById('filter-reset')
  var count = document.getElementById('results-count')

  var FILTER_KEYS = ['category', 'declaration', 'verdict', 'severity', 'source', 'version']

  function matches(entry) {
    var query = (controls.name.value || '').trim().toLowerCase()
    if (query !== '') {
      var haystack = (entry.name + ' ' + (entry.description || '')).toLowerCase()
      if (haystack.indexOf(query) === -1) return false
    }
    if (controls.category.value !== '' && entry.category !== controls.category.value) return false
    if (controls.declaration.value !== '' && entry.declarationTypes.indexOf(controls.declaration.value) === -1) return false
    if (controls.verdict.value !== '' && (entry.verdict || 'unavailable') !== controls.verdict.value) return false
    if (controls.severity.value !== '' && entry.severity !== controls.severity.value) return false
    if (controls.source.value !== '' && entry.sourceKind !== controls.source.value) return false
    if (controls.version.value !== '' && entry.testedDshVersions.indexOf(controls.version.value) === -1) return false
    return true
  }

  function apply() {
    var shown = 0
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i]
      var item = items.get(entry.slug)
      if (item === undefined) continue
      var visible = matches(entry)
      item.hidden = !visible
      if (visible) shown += 1
    }
    if (count !== null) {
      count.textContent = 'Showing ' + String(shown) + ' of ' + String(entries.length) + ' plugins'
    }
  }

  if (controls.name !== null) controls.name.addEventListener('input', apply)
  for (var k = 0; k < FILTER_KEYS.length; k += 1) {
    var control = controls[FILTER_KEYS[k]]
    if (control !== null) control.addEventListener('change', apply)
  }
  if (reset !== null) {
    reset.addEventListener('click', function () {
      if (controls.name !== null) controls.name.value = ''
      for (var j = 0; j < FILTER_KEYS.length; j += 1) {
        var filter = controls[FILTER_KEYS[j]]
        if (filter !== null) filter.value = ''
      }
      apply()
    })
  }

  apply()
})()
