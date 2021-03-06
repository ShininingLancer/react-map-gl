import {PureComponent, createElement, createContext} from 'react';
import PropTypes from 'prop-types';

import StaticMap from './static-map';
import {MAPBOX_LIMITS} from '../utils/map-state';
import WebMercatorViewport from 'viewport-mercator-project';

import TransitionManager from '../utils/transition-manager';

import {EventManager} from 'mjolnir.js';
import MapControls from '../utils/map-controls';
import config from '../config';
import deprecateWarn from '../utils/deprecate-warn';

export const InteractiveContext = createContext({
  eventManager: null,
  isDragging: false
});

const propTypes = Object.assign({}, StaticMap.propTypes, {
  // Additional props on top of StaticMap

  /** Viewport constraints */
  // Max zoom level
  maxZoom: PropTypes.number,
  // Min zoom level
  minZoom: PropTypes.number,
  // Max pitch in degrees
  maxPitch: PropTypes.number,
  // Min pitch in degrees
  minPitch: PropTypes.number,

  // Callbacks fired when the user interacted with the map. The object passed to the callbacks
  // contains viewport properties such as `longitude`, `latitude`, `zoom` etc.
  onViewStateChange: PropTypes.func,
  onViewportChange: PropTypes.func,
  onInteractionStateChange: PropTypes.func,

  /** Viewport transition **/
  // transition duration for viewport change
  transitionDuration: PropTypes.number,
  // TransitionInterpolator instance, can be used to perform custom transitions.
  transitionInterpolator: PropTypes.object,
  // type of interruption of current transition on update.
  transitionInterruption: PropTypes.number,
  // easing function
  transitionEasing: PropTypes.func,
  // transition status update functions
  onTransitionStart: PropTypes.func,
  onTransitionInterrupt: PropTypes.func,
  onTransitionEnd: PropTypes.func,

  /** Enables control event handling */
  // Scroll to zoom
  scrollZoom: PropTypes.bool,
  // Drag to pan
  dragPan: PropTypes.bool,
  // Drag to rotate
  dragRotate: PropTypes.bool,
  // Double click to zoom
  doubleClickZoom: PropTypes.bool,
  // Multitouch zoom
  touchZoom: PropTypes.bool,
  // Multitouch rotate
  touchRotate: PropTypes.bool,
  // Keyboard
  keyboard: PropTypes.bool,

 /**
    * Called when the map is hovered over.
    * @callback
    * @param {Object} event - The mouse event.
    * @param {[Number, Number]} event.lngLat - The coordinates of the pointer
    * @param {Array} event.features - The features under the pointer, using Mapbox's
    * queryRenderedFeatures API:
    * https://www.mapbox.com/mapbox-gl-js/api/#Map#queryRenderedFeatures
    * To make a layer interactive, set the `interactive` property in the
    * layer style to `true`. See Mapbox's style spec
    * https://www.mapbox.com/mapbox-gl-style-spec/#layer-interactive
    */
  onHover: PropTypes.func,
  /**
    * Called when the map is clicked.
    * @callback
    * @param {Object} event - The mouse event.
    * @param {[Number, Number]} event.lngLat - The coordinates of the pointer
    * @param {Array} event.features - The features under the pointer, using Mapbox's
    * queryRenderedFeatures API:
    * https://www.mapbox.com/mapbox-gl-js/api/#Map#queryRenderedFeatures
    * To make a layer interactive, set the `interactive` property in the
    * layer style to `true`. See Mapbox's style spec
    * https://www.mapbox.com/mapbox-gl-style-spec/#layer-interactive
    */
  onClick: PropTypes.func,
  /**
    * Called when the context menu is activated.
    */
  onContextMenu: PropTypes.func,

  /** Custom touch-action CSS for the event canvas. Defaults to 'none' */
  touchAction: PropTypes.string,

  /** Radius to detect features around a clicked point. Defaults to 0. */
  clickRadius: PropTypes.number,

  /** List of layers that are interactive */
  interactiveLayerIds: PropTypes.array,

  /** Accessor that returns a cursor style to show interactive state */
  getCursor: PropTypes.func,

  // A map control instance to replace the default map controls
  // The object must expose one property: `events` as an array of subscribed
  // event names; and two methods: `setState(state)` and `handle(event)`
  mapControls: PropTypes.shape({
    events: PropTypes.arrayOf(PropTypes.string),
    handleEvent: PropTypes.func
  })
});

const getDefaultCursor = ({isDragging, isHovering}) => isDragging ?
  config.CURSOR.GRABBING :
  (isHovering ? config.CURSOR.POINTER : config.CURSOR.GRAB);

const defaultProps = Object.assign({},
  StaticMap.defaultProps, MAPBOX_LIMITS, TransitionManager.defaultProps,
  {
    onViewStateChange: null,
    onViewportChange: null,
    onClick: null,
    onHover: null,
    onContextMenu: event => event.preventDefault(),

    scrollZoom: true,
    dragPan: true,
    dragRotate: true,
    doubleClickZoom: true,

    touchAction: 'none',
    clickRadius: 0,
    getCursor: getDefaultCursor
  }
);

export default class InteractiveMap extends PureComponent {

  static supported() {
    return StaticMap.supported();
  }

  constructor(props) {
    super(props);
    // Check for deprecated props
    deprecateWarn(props);

    this.state = {
      // Whether the cursor is down
      isDragging: false,
      // Whether the cursor is over a clickable feature
      isHovering: false
    };

    // If props.mapControls is not provided, fallback to default MapControls instance
    // Cannot use defaultProps here because it needs to be per map instance
    this._mapControls = props.mapControls || new MapControls();

    this._eventManager = new EventManager(null, {
      legacyBlockScroll: false,
      touchAction: props.touchAction
    });
    this._width = 0;
    this._height = 0;
  }

  componentDidMount() {
    const eventManager = this._eventManager;

    // Register additional event handlers for click and hover
    eventManager.on({
      mousemove: this._onMouseMove,
      click: this._onMouseClick,
      contextmenu: this._onContextMenu
    });

    this._setControllerProps(this.props);
  }

  componentWillUpdate(nextProps) {
    this._setControllerProps(nextProps);
  }

  getMap = () => {
    return this._map ? this._map.getMap() : null;
  }

  queryRenderedFeatures = (geometry, options) => {
    return this._map.queryRenderedFeatures(geometry, options);
  }

  _setControllerProps(props) {
    props = Object.assign({}, props, props.viewState, {
      isInteractive: Boolean(props.onViewStateChange ||
        props.onViewportChange || props.onChangeViewport),
      onViewportChange: this._onViewportChange,
      onStateChange: this._onInteractionStateChange,
      eventManager: this._eventManager,
      width: this._width,
      height: this._height
    });

    this._mapControls.setOptions(props);
  }

  _getFeatures({pos, radius}) {
    let features;
    const queryParams = {};

    if (this.props.interactiveLayerIds) {
      queryParams.layers = this.props.interactiveLayerIds;
    }

    if (radius) {
      // Radius enables point features, like marker symbols, to be clicked.
      const size = radius;
      const bbox = [[pos[0] - size, pos[1] + size], [pos[0] + size, pos[1] - size]];
      features = this._map.queryRenderedFeatures(bbox, queryParams);
    } else {
      features = this._map.queryRenderedFeatures(pos, queryParams);
    }
    return features;
  }

  _onInteractionStateChange = (interactionState) => {
    const {isDragging = false} = interactionState;
    if (isDragging !== this.state.isDragging) {
      this.setState({isDragging});
    }

    const {onInteractionStateChange} = this.props;
    if (onInteractionStateChange) {
      onInteractionStateChange(interactionState);
    }
  }

  _onResize = ({width, height}) => {
    this._width = width;
    this._height = height;
    this._setControllerProps(this.props);
    this.props.onResize({width, height});
  }

  _onViewportChange = (viewState, interactionState, oldViewState) => {
    const onViewStateChange = this.props.onViewStateChange;
    const onViewportChange = this.props.onViewportChange || this.props.onChangeViewport;

    if (onViewStateChange) {
      onViewStateChange({viewState, interactionState, oldViewState});
    }
    if (onViewportChange) {
      onViewportChange(viewState, interactionState, oldViewState);
    }
  }

  // HOVER AND CLICK
  _getPos(event) {
    const {offsetCenter: {x, y}} = event;
    return [x, y];
  }

  _onMouseMove = (event) => {
    if (!this.state.isDragging) {
      const pos = this._getPos(event);
      const features = this._getFeatures({pos, radius: this.props.clickRadius});

      const isHovering = this.props.interactiveLayerIds && features && features.length > 0;
      if (isHovering !== this.state.isHovering) {
        this.setState({isHovering});
      }

      if (this.props.onHover) {
        const viewport = new WebMercatorViewport(Object.assign({}, this.props, {
          width: this._width,
          height: this._height
        }));
        event.lngLat = viewport.unproject(pos);
        event.features = features;

        this.props.onHover(event);
      }
    }
  }

  _onMouseClick = (event) => {
    if (this.props.onClick) {
      const pos = this._getPos(event);
      const viewport = new WebMercatorViewport(Object.assign({}, this.props, {
        width: this._width,
        height: this._height
      }));
      event.lngLat = viewport.unproject(pos);
      event.features = this._getFeatures({pos, radius: this.props.clickRadius});

      this.props.onClick(event);
    }
  }

  _onContextMenu = (event) => {
    if (this.props.onContextMenu) {
      this.props.onContextMenu(event);
    }
  }

  _eventCanvasLoaded = (ref) => {
    // This will be called with `null` after unmount, releasing event manager resource
    this._eventManager.setElement(ref);
  }

  _staticMapLoaded = (ref) => {
    this._map = ref;
  }

  render() {
    const {width, height, style, getCursor} = this.props;

    const eventCanvasStyle = Object.assign({position: 'relative'}, style, {
      width,
      height,
      cursor: getCursor(this.state)
    });
    const interactiveContext = {
      isDragging: this.state.isDragging,
      eventManager: this._eventManager
    };

    return createElement(InteractiveContext.Provider, {value: interactiveContext},
      createElement('div', {
        key: 'map-controls',
        ref: this._eventCanvasLoaded,
        style: eventCanvasStyle
      },
        createElement(StaticMap, Object.assign({}, this.props,
          {
            width: '100%',
            height: '100%',
            style: null,
            onResize: this._onResize,
            ref: this._staticMapLoaded,
            children: this.props.children
          }
        ))
      )
    );
  }
}

InteractiveMap.displayName = 'InteractiveMap';
InteractiveMap.propTypes = propTypes;
InteractiveMap.defaultProps = defaultProps;
