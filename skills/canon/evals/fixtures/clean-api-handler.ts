
type UserRecord = { id: string; email: string };
type Request = { params: { id?: string } };
type Response = {
  status: (code: number) => Response;
  json: (body: unknown) => Response;
};

const UserService = {
  findById: async (_id: string): Promise<UserRecord | null> => null,
};

function parseUserParams(params: Request["params"]): { success: true; data: { id: string } } | { success: false } {
  const id = params.id;
  if (!id || typeof id !== "string") return { success: false };
  return { success: true, data: { id } };
}

export async function getUser(req: Request, res: Response) {
  const parsed = parseUserParams(req.params);
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
