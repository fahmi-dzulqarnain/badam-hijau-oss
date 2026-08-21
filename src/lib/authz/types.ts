export type SpaceRole = "VIEWER" | "EDITOR" | "ADMIN";
export type SpaceVisibility = "MEMBERS" | "ALL_STAFF";
export type Action = "READ" | "EDIT" | "PUBLISH" | "MANAGE_SPACE";

export type Membership = { spaceId: string; role: SpaceRole };

export type Viewer = {
  id: string;
  isSuperAdmin: boolean;
  memberships: Membership[];
};

export type SpaceRef = { id: string; visibility: SpaceVisibility };
