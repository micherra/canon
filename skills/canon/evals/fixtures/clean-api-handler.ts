// src/api/handlers/users.ts
import { Request, Response } from "express";
import { UserService } from "../../domain/user-service";

export async function getUser(req: Request, res: Response) {
  const user = await UserService.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  return res.json(user);
}
