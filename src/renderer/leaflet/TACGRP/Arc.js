/* eslint-disable */

import L from 'leaflet'
import { toLatLngs, toGeometry } from '../GeoJSON'
import { line } from './shapes/geo-helper'
import { FULCRUM } from './handle-types'
import { wrap360 } from '../geodesy'

export const arcGeometry = (latlng, orientation, size, radius) => {
  const C = latlng
  const O = latlng.destinationPoint(radius, orientation)
  const S = latlng.destinationPoint(radius, orientation + size)

  orientation = wrap360(orientation)

  // TODO: provide nice copy ctor

  return {
    C,
    O,
    S,
    orientation,
    size,
    radius,
    radians: {
      start: (orientation - 90) / 180 * Math.PI,
      end: (orientation - 90 + size) / 180 * Math.PI,
      delta: size / 180 * Math.PI
    }
  }
}

L.TACGRP.Arc = L.TACGRP.Feature.extend({

  /**
   *
   */
  _project () {
    const layerPoint = this._map.latLngToLayerPoint.bind(this._map)
    const C = layerPoint(this._arc.C)
    const O = layerPoint(this._arc.O)
    const S = layerPoint(this._arc.S)

    this._shape.updateFrame({
      C,
      O,
      S,
      radius: line([C, O]).d,
      radians: this._arc.radians
    })
  },


  /**
   *
   */
  _editor () {
    const layer = new L.Feature.Handles().addTo(this._map)
    let current = this._arc

    const handlers = {
      C: {
        latlng: arc => arc.C,
        arc: latlng => arcGeometry(
          latlng,
          current.orientation,
          current.size,
          current.radius
        )
      },
      O: {
        latlng: arc => arc.O,
        arc: latlng => arcGeometry(
          current.C,
          current.C.finalBearingTo(latlng),
          current.size,
          current.C.distance(latlng)
        )
      },
      S: {
        latlng: arc => arc.S,
        arc: latlng => arcGeometry(
          current.C,
          current.C.finalBearingTo(latlng) - current.size,
          current.size,
          current.C.distance(latlng)
        )
      }
    }

    const xyz = (channel, arc) => {
      this._arc = current = arc
      this._project()
      Object.keys(handlers).forEach(id => handles[id].setLatLng(arc[id]))

      if (channel === 'dragend') {
        const geometry = toGeometry('Point', arc.C)
        const properties = {
          geometry_max_range: arc.radius,
          geometry_orient_angle: arc.orientation,
        }

        return this.options.update({ geometry, properties })
      }
    }

    const handles = Object.entries(handlers).reduce((acc, [id, handler]) => {
      const handleOptions = {
        type: FULCRUM,
        drag: ({ target }) => xyz('drag', handler.arc(target.getLatLng())),
        dragend: ({ target }) => xyz('dragend', handler.arc(target.getLatLng()))
      }

      const latlng = handler.latlng(current)
      acc[id] = layer.addHandle(latlng, handleOptions)
      return acc
    }, {})

    return {
      dispose: () => this._map.removeLayer(layer)
    }
  },


  /**
   *
   */
  _setFeature (feature) {
    /* eslint-disable camelcase */
    const { geometry_max_range, geometry_orient_angle, geometry_size_angle } = feature.properties

    this._arc = arcGeometry(
      toLatLngs(feature.geometry),
      geometry_orient_angle,
      geometry_size_angle,
      geometry_max_range
    )

    this._shapeOptions = {
      interactive: this.options.interactive,
      labels: this._labels(),
      styles: this._styles(feature)
    }
  }
})
