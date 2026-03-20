// src/api/handlers/users.ts
import { Request, Response } from "express";
import { z } from "zod";
import { UserService } from "../../domain/user-service";

const GetUserParams = z.object({
  id: z.string().uuid(),
});

export async function getUser(req: Request, res: Response) {
  const parsed = GetUserParams.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid user ID" });

  try {
    const user = await UserService.findById(parsed.data.id);
    if (!user) return res.status(404).json({ error: "Not found" });
    return res.json(user);
  } catch (error) {
    console.error("Failed to fetch user:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
