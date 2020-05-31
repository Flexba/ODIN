import { GeoJSON } from 'ol/format'
import * as ol from 'ol'

import { K, I, uniq } from '../../shared/combinators'
import undo from '../undo'
import Feature from './Feature'
import URI from './URI'
import evented from '../evented'
import * as clipboard from '../clipboard'
import selection from '../selection'
import * as io from './io'
import preferences from './preferences'

/**
 * Properties excluded from regular properties.
 */
const internalProperties = ['layerId', 'geometry', 'locked', 'hidden']

/**
 * Project layer/feature model.
 * Model is updated through public functions.
 * Updates are propagated as events to registered reducers.
 *
 * NOTE: Events are emitted in a pretty relaxed manner (setImmediate()).
 * I.e. event emitting is scheduled behind outstandig I/O.
 * This is probably not necessary, but we want to play nice and not
 * choke our precious thread. Reducers have to live with it.
 */


// --
// SECTION: In-memory state: layer file names and features.

const layerList = {}

const layerName =
  layerId =>
    layerList[layerId].name

/**
 * features :: string ~> ol/Feature
 *
 * NOTE: We choose to store ol/Feature instead of object/JSON
 * for a number of reasons.
 *   - support for cloning of features and geometries
 *   - features are directly shared (mostly R/O) with views
 *   - Web-Mercator projection is used throughout the model
 */
const featureList = {}

/**
 * deletableSelection :: () -> [string]
 * Ids of selected features which are neither locked nor hidden.
 */
const deletableSelection = () =>
  selection.selected(URI.isFeatureId)
    .map(id => featureList[id])
    .filter(Feature.showing)
    .filter(Feature.unlocked)
    .map(Feature.id)

/**
 * layerFeatures :: string -> [ol/Feature]
 */
const layerFeatures = layerId =>
  Object.values(featureList)
    .filter(Feature.hasLayerId(layerId))

const geoJSON = new GeoJSON({
  dataProjection: 'EPSG:4326', // WGS84
  featureProjection: 'EPSG:3857' // Web-Mercator
})

/**
 * disambiguateLayerName :: string -> string
 */
const disambiguateLayerName = basename => {
  const exactMatch =
    Object.values(layerList)
      .map(layer => layer.name)
      .find(name => name === basename)

  if (!exactMatch) return basename
  else {
    // Normalize match if already ends with (n)
    const specialMatch = exactMatch.match(/^(.*) \(\d+\)$/)
    const match = specialMatch ? specialMatch[1] : exactMatch

    const candidates = Object.values(layerList)
      .map(layer => layer.name)
      .map(name => name.match(new RegExp(`${match} \\((\\d+)\\)`, 'i')))
      .filter(I)
      .filter(match => match.length > 1)
      .map(match => parseInt(match[1]))

    const maxN = candidates.length !== 0
      ? candidates.reduce((a, b) => Math.max(a, b))
      : 0

    return `${match} (${maxN + 1})`
  }
}

// --
// SECTION: Input layer I/O.


/**
 * readFeatures :: (string, string) -> [ol/Feature]
 */
const readFeatures = (layerId, contents) => {
  if (contents.length === 0) return []

  return geoJSON.readFeatures(contents).map(feature => K(feature)(feature => {
    feature.setId(URI.featureId(layerId))
    feature.set('layerId', layerId)
  }))
}


/**
 * writeFeatures :: a (ol/Feature | featureId | layerId) => [a] -> unit
 */
const writeFeatures = xs =>
  xs
    .map(x => x instanceof ol.Feature ? Feature.layerId(x) : x)
    .map(s => URI.isFeatureId(s) ? URI.layerId(s) : s)
    .filter(uniq)
    .map(layerId => ({ name: layerName(layerId), features: layerFeatures(layerId) }))
    .map(({ name, features }) => ({ name, contents: geoJSON.writeFeatures(features) }))
    .forEach(({ name, contents }) => io.writeLayer(name, contents))


/**
 * reducers :: [(event) -> unit]
 */
let reducers = []

const register = reducer => {
  reducers = [...reducers, reducer]

  // Prepare layers/features snapshot for new reducer.
  // NOTE: Early bird registrations will probably miss features,
  // because they are loaded asynchronously, but 'featuresadded' event
  // will accommodate for that.
  const layers = Object.values(layerList).map(layer => {
    const features = layerFeatures(layer.id)
    return {
      ...layer,
      locked: features.some(Feature.locked),
      hidden: features.some(Feature.hidden)
    }
  })

  setImmediate(() => reducer({
    type: 'snapshot',
    layers,
    features: Object.values(featureList)
  }))
}

const deregister = reducer => (reducers = reducers.filter(x => x !== reducer))
const emit = event => reducers.forEach(reducer => setImmediate(() => reducer(event)))


// --
// SECTION: Initialization.
// NOTE: Currently, project lifecycle is bound to renderer window.


/**
 * Load layers from project.
 */
;(() => {
  const activeLayer = preferences.get('activeLayer')

  io.loadLayers().forEach(({ name, contents }) => {
    const id = URI.layerId()
    layerList[id] = { id, name, active: activeLayer === name }
    const additions = readFeatures(id, contents)
    additions.forEach(feature => (featureList[Feature.id(feature)] = feature))
    emit({ type: 'featuresadded', features: additions, selected: false })
  })
})()


// --
// SECTION: Commands

/**
 * insertFeaturesCommand :: [ol/Feature] -> command
 * Add given features to corresponding input layer.
 */
const insertFeaturesCommand = clones => {
  const additions = clones.map(feature => {
    const layerId = Feature.layerId(feature)
    feature.setId(URI.featureId(layerId))
    return feature
  })

  return {
    inverse: () => deleteFeaturesCommand(additions.map(feature => Feature.id(feature))),
    apply: () => {
      additions.forEach(feature => (featureList[Feature.id(feature)] = feature))
      emit({ type: 'featuresadded', features: additions, selected: true })
      writeFeatures(additions)
    }
  }
}

/**
 * deleteFeaturesCommand :: [string] -> command
 * Delete features with given ids.
 */
const deleteFeaturesCommand = featureIds => {

  // Create clones (without ids) to re-insert if necessary.
  const clones = featureIds
    .map(id => featureList[id])
    .map(feature => feature.clone())

  return {
    inverse: () => insertFeaturesCommand(clones),
    apply: () => {
      selection.deselect(featureIds)
      featureIds.forEach(id => delete featureList[id])
      emit({ type: 'featuresremoved', ids: featureIds })
      writeFeatures(featureIds)
    }
  }
}

/**
 * updateGeometriesCommand
 *   :: (string ~> ol/Geometry) -> (string ~> ol/Geometry) -> command
 */
const updateGeometriesCommand = (initial, current) => ({
  inverse: () => updateGeometriesCommand(current, initial),
  apply: () => {
    const features = Object.entries(initial)
      .map(([id, geometry]) => [featureList[id], geometry])
      .map(([feature, geometry]) => K(feature)(feature => (feature.setGeometry(geometry))))

    writeFeatures(features)
  }
})

/**
 * renameLayerCommand :: (string, string, string) -> command
 */
const renameLayerCommand = (layerId, prevName, nextName) => ({
  inverse: () => renameLayerCommand(layerId, nextName, prevName),
  apply: () => {
    io.renameLayer(prevName, nextName)
    layerList[layerId] = {
      ...layerList[layerId],
      name: nextName
    }

    if (layerList[layerId].active) {
      preferences.set('activeLayer', layerList[layerId].name)
    }

    emit({ type: 'layerrenamed', layerId, name: nextName })
  }
})

/**
 * unlinkLayerCommand :: string -> command
 * Delete JSON input layer file.
 */
const unlinkLayerCommand = layerId => {
  const name = layerName(layerId)
  const contents = io.readLayer(name)

  return {
    inverse: () => writeLayerCommand(layerId, name, contents),
    apply: () => {
      io.deleteLayer(name)
      deactivateLayer(layerId)

      const featureIds = layerFeatures(layerId).map(Feature.id)
      selection.deselect(featureIds)
      selection.deselect([layerId])

      featureIds.forEach(id => delete featureList[id])
      delete layerList[layerId]

      emit({ type: 'layerremoved', layerId })
    }
  }
}

/**
 * writeLayerCommand :: (string, string, string) -> command
 * Write new JSON input layer file with given contents.
 */
const writeLayerCommand = (layerId, basename, contents) => {

  return {
    inverse: () => unlinkLayerCommand(layerId),
    apply: () => {
      const name = disambiguateLayerName(basename)
      io.writeLayer(name, contents)
      layerList[layerId] = {
        id: layerId,
        name,
        active: false
      }

      const features = readFeatures(layerId, contents)
      features.forEach(feature => (featureList[Feature.id(feature)] = feature))

      emit({
        type: 'layeradded',
        layer: {
          ...layerList[layerId],
          locked: features.some(Feature.locked),
          hidden: features.some(Feature.hidden)
        },
        features
      })
    }
  }
}

// --
// SECTION: Public API.

/**
 * removeFeatures :: [string] -> unit
 */
const removeFeatures = featureIds => {
  undo.applyAndPush(deleteFeaturesCommand(featureIds))
}

/**
 * addFeatures :: [[string]] -> unit
 */
const addFeatures = content => {
  const additions = content.map(json => geoJSON.readFeature(json))

  // Add features to active layer if defined.
  const activeLayer = Object.entries(layerList).find(([_, layer]) => layer.active)
  if (activeLayer) {
    additions.forEach(feature => feature.set('layerId', activeLayer[0]))
  }

  undo.applyAndPush(insertFeaturesCommand(additions))
}

/**
 * updateGeometries :: ([string, ol/geom/Geometry]) -> [ol/Feature] -> unit
 * Push undoable command to revert geometries AFTER the effect.
 */
const updateGeometries = (initial, features) => {
  const current = features
    .map(feature => [Feature.id(feature), Feature.cloneGeometry(feature)])
    .reduce((acc, [id, geometry]) => K(acc)(acc => (acc[id] = geometry)), {})

  // NOTE: No need to apply; geometries are already up to date.
  const command = updateGeometriesCommand(initial, current)
  undo.push(command)
  writeFeatures(features)
}

/**
 * toggleLayerLock :: string -> unit
 * Lock/unlock layer.
 * NOTE: Lock state is stored in features:
 * One locked feature locks layer.
 */
const toggleLayerLock = layerId => {
  const features = layerFeatures(layerId)
  const locked = features.some(Feature.locked)
  const toggle = locked ? Feature.unlock : Feature.lock
  features.forEach(toggle)

  if (!locked) {
    deactivateLayer(layerId)
    selection.deselect(features.map(Feature.id))
  }

  writeFeatures(features)
  emit({ type: 'layerlocked', layerId, locked: !locked })
}

/**
 * toggleLayerShow :: string -> unit
 * Hide/show layer.
 * NOTE: Hidden state is stored in features:
 * One hidden feature hides layer.
 */
const toggleLayerShow = layerId => {
  const features = layerFeatures(layerId)
  const hidden = features.some(Feature.hidden)
  const toggle = hidden ? Feature.unhide : Feature.hide
  features.forEach(toggle)

  if (!hidden) {
    deactivateLayer(layerId)
    selection.deselect(features.map(Feature.id))
  }


  writeFeatures(features)
  emit({ type: 'layerhidden', layerId, hidden: !hidden })
}

/**
 * activateLayer :: string -> unit
 * Set layer as 'active layer'.
 */
const activateLayer = layerId => {

  // Ignore if layer is hidden or locked.
  const features = layerFeatures(layerId)
  const hidden = features.some(Feature.hidden)
  const locked = features.some(Feature.locked)
  if (hidden || locked) return

  Object.values(layerList).forEach(layer => (layer.active = false))
  layerList[layerId].active = true
  emit({ type: 'layeractivated', layerId })
  evented.emit('OSD_MESSAGE', { message: layerName(layerId), slot: 'A2' })
}

/**
 * deactivateLayer :: string -> unit
 * Unset layer as 'active layer'.
 */
const deactivateLayer = layerId => {
  if (layerList[layerId] && layerList[layerId].active) {
    delete layerList[layerId].active
    emit({ type: 'layerdeactivated', layerId })
    evented.emit('OSD_MESSAGE', { message: '', slot: 'A2' })
  }
}

/**
 * renameLayer :: (string, string) -> unit
 * Rename layer and file to new name.
 */
const renameLayer = (layerId, name) => {
  const command = renameLayerCommand(layerId, layerName(layerId), name)
  undo.applyAndPush(command)
}

/**
 * removeLayer :: string -> unit
 */
const removeLayer =
  layerId =>
    undo.applyAndPush(unlinkLayerCommand(layerId))

/**
 * createLayer :: () -> unit
 */
const createLayer = () => {
  const name = disambiguateLayerName('New Layer')
  const contents = '{"type":"FeatureCollection","features":[]}'

  undo.applyAndPush(writeLayerCommand(
    URI.layerId(),
    name,
    contents
  ))
}

/**
 * duplicateLayer :: string -> unit()
 */
const duplicateLayer = layerId => {
  const name = layerName(layerId)
  const contents = io.readLayer(name)
  undo.applyAndPush(writeLayerCommand(
    URI.layerId(),
    disambiguateLayerName(name),
    contents
  ))
}

/**
 * layerProperties :: string -> string ~> string
 */
const layerProperties = layerId => ({ ...layerList[layerId] })

/**
 * featureProperties :: string -> (string ~> string)
 * Return properties except internal properties.
 */
const featureProperties = featureId => {
  if (!featureId) return null
  const feature = featureList[featureId]
  if (!feature) return null
  const properties = feature.clone().getProperties()
  internalProperties.forEach(property => delete properties[property])
  return properties
}

/**
 * updateFeatureProperties :: (string, string ~> string) -> unit
 * Update (incl. delete) a subset of feature properties excluding the
 * following (internal) properties: layerId, geometry, locked, hidden.
 */
const updateFeatureProperties = (featureId, properties) => {
  if (!featureId) return null
  const feature = featureList[featureId]
  if (!feature) return null

  // Update existing properties and remove
  // properties no longer supplied.
  const silent = true // don't push update events on feature
  feature.setProperties(properties, silent)
  feature.getKeys()
    .filter(key => !internalProperties.includes(key))
    .filter(key => !properties[key])
    .forEach(key => feature.unset(key, silent))

  writeFeatures([feature])
  emit({ type: 'featurepropertiesupdated', featureId, properties })
}

/**
 * Featre clipboard ops.
 */
clipboard.registerHandler(URI.SCHEME_FEATURE, {

  selectAll: () => {
    return Object.values(featureList)
      .filter(Feature.unlocked)
      .filter(Feature.showing)
      .map(Feature.id)
  },

  // NOTE: For COPY operation, feature may be locked.
  copy: () => selection.selected(URI.isFeatureId)
    .map(featureId => featureList[featureId])
    .map(feature => geoJSON.writeFeature(feature)),

  paste: content => addFeatures(content),

  // NOTE: For CUT operation, feature must not be locked.
  cut: () => {
    const ids = deletableSelection()
    const content = ids
      .map(featureId => featureList[featureId])
      .map(feature => geoJSON.writeFeature(feature))

    removeFeatures(ids)
    return content
  },

  delete: () => removeFeatures(deletableSelection())
})


/**
 * Layer clipboards ops.
 */
clipboard.registerHandler(URI.SCHEME_LAYER, {

  copy: () => {
    const selected = selection.selected(URI.isLayerId)
    if (!selected.length) return []

    const layerId = selected[0]
    const name = layerName(layerId)
    return [{ name, contents: io.readLayer(name) }]
  },

  paste: layers => {
    if (!layers || !layers.length) return

    layers.forEach(({ name, contents }) => {
      undo.applyAndPush(writeLayerCommand(
        URI.layerId(),
        disambiguateLayerName(name),
        contents
      ))
    })
  },

  cut: () => {
    const selected = selection.selected(URI.isLayerId)
    if (!selected.length) return []

    const layerId = selected[0]
    const layer = layerList[layerId]
    const content = [{ name: layer.name, contents: io.readLayer(layer.name) }]
    if (!layer.active) removeLayer(layerId)
    return content
  },

  delete: () => {
    const selected = selection.selected(URI.isLayerId)
    if (!selected.length) return

    const layerId = selected[0]
    if (layerList[layerId].active) return

    removeLayer(layerId)
  }
})

/**
 * specialSelection :: () => [string]
 * Id of selected features which aere hidden or locked.
 * NOTE: Hidden and locked features can be selected in layer list,
 * but not in the map.
 */
const specialSelection = () =>
  selection
    .selected(URI.isFeatureId)
    .map(id => featureList[id])
    .filter(Feature.hiddenOrLocked)
    .map(Feature.id)

/**
 * Unconditionally deselect 'special selection' on map click.
 */
evented.on('MAP_CLICKED', () => selection.deselect(specialSelection()))

export default {
  register,
  deregister,
  removeFeatures,
  addFeatures,
  updateGeometries,
  toggleLayerLock,
  toggleLayerShow,
  activateLayer,
  deactivateLayer,
  renameLayer,
  removeLayer,
  createLayer,
  duplicateLayer,
  layerProperties,
  featureProperties,
  updateFeatureProperties
}