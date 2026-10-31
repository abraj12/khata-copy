import { z } from 'zod';

export const loginSchema = z
  .object({
    phone: z
      .string({
        required_error: 'Mobile number is required',
        invalid_type_error: 'Mobile number must be a string',
      })
      .min(10, 'Mobile number must have at least 10 digits')
      .max(15, 'Mobile number is too long')
      .refine(
        (val) => {
          // Normalize check: must be either 10 digits starting with 6-9, or +91 followed by 10 digits
          const cleaned = val.replace(/[\s-]/g, '');
          return /^(?:\+91)?[6-9]\d{9}$/.test(cleaned);
        },
        {
          message: 'Invalid Indian mobile number format. Enter a 10-digit number or +91 format.',
        }
      ),
    password: z
      .string({
        required_error: 'Password is required',
        invalid_type_error: 'Password must be a string',
      })
      .min(1, 'Password cannot be empty')
      .max(128, 'Password cannot exceed 128 characters'),
  })
  .strict(); // Disallow unknown/unexpected properties
