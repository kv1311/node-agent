// Add these to your TOOL_DEFS in groq.js

export const OBLIGATION_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_obligation',
      description:
        'Create a financial obligation between two parties. Models loans, credit cards, debts, rent, bills, etc.',
      parameters: {
        type: 'object',
        properties: {
          from: {
            type: 'string',
            description: 'Who owes (e.g., "me", "Ramesh", "Kotak Bank"). Case-insensitive.',
          },
          to: {
            type: 'string',
            description: 'Who is owed (e.g., "me", "Kotak Bank"). Case-insensitive.',
          },
          amount: {
            type: 'number',
            description: 'Total amount owed in rupees.',
          },
          currency: {
            type: 'string',
            default: 'INR',
            description: 'Currency code (default INR).',
          },
          due_date: {
            type: 'string',
            description: 'Due date in YYYY-MM-DD format (optional).',
          },
          installments: {
            type: 'integer',
            description: 'Number of installments (default 1 for lump sum). Must be positive integer.',
          },
          purpose: {
            type: 'string',
            description:
              'Purpose: loan, credit_card, rent, bill, personal_debt, investment, subscription, etc.',
          },
          notes: {
            type: 'string',
            description: 'Optional additional context.',
          },
        },
        required: ['from', 'to', 'amount', 'purpose'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_settlement',
      description: 'Record a payment towards an obligation (full or partial).',
      parameters: {
        type: 'object',
        properties: {
          obligation_id: {
            type: 'string',
            description: 'ID of the obligation being settled (returned by create_obligation).',
          },
          amount_paid: {
            type: 'number',
            description: 'Amount paid in rupees. Must be positive and <= remaining.',
          },
          payment_date: {
            type: 'string',
            description: 'Date of payment in YYYY-MM-DD format (default: today).',
          },
          from_account: {
            type: 'string',
            description: 'Account used to pay (e.g., "Kotak Debit", "Slice", "Cash", etc.).',
          },
          notes: {
            type: 'string',
            description: 'Optional notes about the payment.',
          },
        },
        required: ['obligation_id', 'amount_paid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_obligations',
      description:
        'Query current obligations. Use to answer "How much does X owe me?" or "What do I owe X?"',
      parameters: {
        type: 'object',
        properties: {
          party: {
            type: 'string',
            description:
              'Name of party (e.g., "me", "Ramesh", "Kotak Bank"). Case-insensitive. Leave empty for all.',
          },
          type: {
            type: 'string',
            enum: ['creditor', 'debtor', 'any'],
            description:
              'creditor = they owe me, debtor = I owe them, any = both (default: any).',
          },
          status: {
            type: 'string',
            enum: ['active', 'settled', 'any'],
            default: 'active',
            description: 'Filter by status (default: active).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_obligation_detail',
      description: 'Get full history of a single obligation with all payments.',
      parameters: {
        type: 'object',
        properties: {
          obligation_id: {
            type: 'string',
            description: 'ID of the obligation.',
          },
        },
        required: ['obligation_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_balance',
      description:
        'Update account or asset balance. Use for bank balances, wallet amounts (not obligations).',
      parameters: {
        type: 'object',
        properties: {
          account: {
            type: 'string',
            description: 'Account name (e.g., "Kotak", "Slice", "Cash", "Apple Pay").',
          },
          amount: {
            type: 'number',
            description: 'Current balance amount. Must be non-negative.',
          },
          currency: {
            type: 'string',
            default: 'INR',
            description: 'Currency code.',
          },
        },
        required: ['account', 'amount'],
      },
    },
  },
]