import { domMax } from 'framer-motion';

/**
 * Loaded on demand by `MotionProvider` so the ~38 KB animation runtime (layout, drag) stays
 * out of every route's first-load bundle. `domMax` (not `domAnimation`)
 * because layout animations and drag-to-dismiss need it.
 */
export default domMax;
