// src/domain/orders/order-service.ts
import { Customer } from "../customers/customer-model"; // cross-context import
import { Order } from "./order-model";

export function createOrder(customer: Customer, items: string[]): Order {
  return { customerId: customer.id, items, status: "pending" };
}
