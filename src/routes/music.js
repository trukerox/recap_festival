import { Router } from "express";
import { listActive } from "../repositories/musicTracks.js";

export const musicRouter = Router();

musicRouter.get("/", async (req, res, next) => {
  try {
    const tracks = await listActive(req.query.genre);
    res.json(tracks);
  } catch (err) {
    next(err);
  }
});

export default musicRouter;
