import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  apiCalls,
  apiImpact,
  linkContracts,
  repositoryLinks,
  visibleContracts,
} from '../src/api-contracts.js';
import {
  embeddedDocuments,
  generatedOperationName,
  readGraphqlFacts,
  type GraphqlFacts,
} from '../src/graphql-contracts.js';
import { createTreeSitterManager, type TreeSitterManager } from '../src/tree-sitter-parser.js';

const SCHEMA = `
type Query { books: BooksQuery! shelf(id: ID!): Shelf }
type Mutation { books: BooksMutationsPayload! }
type BooksQuery { find(query: String): [Book!]! }
type BooksMutationsPayload { lend(input: String!): LendPayload }
type LendPayload { book: Book success: Boolean! }
type Book implements Item { id: ID! title: String! lentBy: String shelf: Shelf }
interface Item { id: ID! }
type Shelf { id: ID! name: String! items: [Holding!]! }
union Holding = Book
`;

const RUBY: Record<string, string> = {
  'app/graphql/types/query.rb': `module Types
  class Query < Types::Base
    field :books, resolver: Resolvers::Books::Root
    field :shelf, resolver: Resolvers::Shelf
  end
end
`,
  'app/graphql/resolvers/books/root.rb': `module Resolvers
  module Books
    class Root < Resolvers::Base
      class BooksQuery < Types::Base
        field :find, resolver: Resolvers::Books::Find
      end
      type BooksQuery, null: false
      def resolve
        self
      end
    end
  end
end
`,
  'app/graphql/resolvers/books/find.rb': `module Resolvers
  module Books
    class Find < Resolvers::Base
      def resolve(query: nil)
        Catalog.search(query)
      end
    end
  end
end
`,
  'app/graphql/resolvers/shelf.rb': `module Resolvers
  class Shelf < Resolvers::Base
    def resolve(id:)
      ::Shelf.find(id)
    end
  end
end
`,
  'app/graphql/mutations/books/root.rb': `module Mutations
  module Books
    class Root < Mutations::Base
      graphql_name 'BooksMutations'
      field :lend, mutation: Mutations::Books::Lend
    end
  end
end
`,
  'app/graphql/mutations/books/lend.rb': `module Mutations
  module Books
    class Lend < Mutations::Base
      field :book, Types::Book, null: true
      field :success, Boolean, null: false
      def resolve(input:)
        Lending.call(input)
      end
    end
  end
end
`,
  'app/graphql/types/book.rb': `module Types
  class BookType < Types::Base
    graphql_name 'Book'
    include Types::Concerns::Shelved
    Types::Concerns::Lendable.declare(self)
    field :id, ID, null: false
    field :title, String, null: false
    delegate :title, to: :object
  end
end
`,
  'app/graphql/types/concerns/shelved.rb': `module Types
  module Concerns
    module Shelved
      def self.included(base)
        base.field :shelf, Types::Shelf, null: true
      end
      def shelf
        object.shelf
      end
    end
  end
end
`,
  'app/graphql/types/concerns/lendable.rb': `module Types
  module Concerns
    module Lendable
      def self.declare(base)
        base.field :lent_by, String, null: true
      end
    end
  end
end
`,
  Gemfile: `gem 'graphql'\n`,
};

const dirs: string[] = [];
const write = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-'));
  dirs.push(root);
  for (const [file, text] of Object.entries(files)) {
    const abs = path.join(root, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

let treeSitter: TreeSitterManager;
beforeAll(async () => {
  treeSitter = await createTreeSitterManager();
});

const server = (extra: Record<string, string> = {}): Promise<GraphqlFacts | null> =>
  readGraphqlFacts(write({ ...RUBY, 'public/schema.graphql': SCHEMA, ...extra }), treeSitter);
const client = (files: Record<string, string>): Promise<GraphqlFacts | null> =>
  readGraphqlFacts(write(files), treeSitter);

const FIND = `query FindBooks($q: String) {
  books { find(query: $q) { ...BookRow } }
}
fragment BookRow on Book { id title lentBy shelf { name } }
`;
const LEND = `mutation LendBook($input: String!) {
  books { lend(input: $input) { success book { id } } }
}
`;

describe('reading what a project says about its API', () => {
  it('finds GraphQL inside source code, not other templates', () => {
    const ts = [
      'const a = gql`query One { books { find { id } } }`;',
      'const b = `query Two { books { find { id } } }`;',
      'const c = `query is what the user typed`;',
      'const d = gql`fragment F on Book { id ${other} }`;',
    ].join('\n');
    expect(embeddedDocuments('a.ts', ts).map((d) => d.line)).toEqual([0, 1, 3]);
    const rb = 'QUERY = <<~GRAPHQL\n  query Three { books { find { id } } }\nGRAPHQL\n';
    expect(embeddedDocuments('a_spec.rb', rb)).toHaveLength(1);
    const py = 'q = gql("""query Four { books { find { id } } }""")';
    expect(embeddedDocuments('a.py', py)).toHaveLength(1);
  });

  it('names the operation a generated name stands for', () => {
    expect(generatedOperationName('FindBooksDocument')).toBe('FindBooks');
    expect(generatedOperationName('useFindBooksLazyQuery')).toBe('FindBooks');
    expect(generatedOperationName('useLendBookMutation')).toBe('LendBook');
    expect(generatedOperationName('Catalog')).toBeNull();
  });

  it('reads nothing where the project has no directory', async () => {
    expect(await readGraphqlFacts('/no/such/dir', treeSitter)).toBeNull();
  });

  it('leaves generated code and what the project excludes out, tests in', async () => {
    const root = write({
      'src/One.graphql': 'query One { books { find { id } } }',
      'src/__generated__/graphql.ts': 'const a = gql`query Gen { books { find { id } } }`;',
      'out/Two.graphql': 'query Two { books { find { id } } }',
      'spec/three.graphql': 'query Three { books { find { id } } }',
    });
    const facts = await readGraphqlFacts(root, treeSitter, ['out/**', 'spec/**']);
    expect(facts?.documents.map((d) => d.file).sort()).toEqual([
      'spec/three.graphql',
      'src/One.graphql',
    ]);
  });
});

describe('linking operations to the code answering them', () => {
  it('reads every selected field through fragments, to the code answering it', async () => {
    const back = (await server())!;
    const web = (await client({
      'src/FindBooks.query.graphql': FIND,
      'src/List.tsx': 'const r = useQuery(FindBooksDocument);\n',
    }))!;
    const { links, unmatched } = linkContracts([
      ['back', back],
      ['web', web],
    ]);
    expect(unmatched).toEqual([]);
    const answers = new Map(links.map((l) => [l.field, l.provider]));
    expect(answers.get('BooksQuery.find')).toMatchObject({
      project: 'back',
      file: 'app/graphql/resolvers/books/find.rb',
      symbol: 'Resolvers::Books::Find#resolve',
      method: 'resolve',
      declaredAt: { file: 'app/graphql/resolvers/books/root.rb' },
    });
    // A delegate is the method answering the field.
    expect(answers.get('Book.title')).toMatchObject({ method: 'title', line: 7 });
    // Declared by a mixin through `base.field`, its method beside it.
    expect(answers.get('Book.shelf')).toMatchObject({
      file: 'app/graphql/types/concerns/shelved.rb',
      symbol: 'Types::Concerns::Shelved#shelf',
    });
    // `Mixin.declare(self)`, no method: the declaration.
    expect(answers.get('Book.lentBy')).toMatchObject({
      file: 'app/graphql/types/concerns/lendable.rb',
    });
    expect(answers.get('Book.lentBy')?.method).toBeUndefined();
    expect(links.every((l) => l.certain)).toBe(true);
    const op = links.find((l) => l.field === 'BooksQuery.find')!.operation;
    expect(op).toMatchObject({ project: 'web', name: 'FindBooks', kind: 'query', line: 0 });
    expect(op.usedIn).toEqual([{ file: 'src/List.tsx', line: 0 }]);
  });

  it('finds a mutation through the payload type graphql-ruby makes', async () => {
    const { links } = linkContracts([
      ['back', (await server())!],
      ['web', (await client({ 'Lend.graphql': LEND }))!],
    ]);
    const answers = new Map(links.map((l) => [l.field, l.provider]));
    expect(answers.get('BooksMutationsPayload.lend')?.symbol).toBe(
      'Mutations::Books::Lend#resolve'
    );
    expect(answers.get('LendPayload.success')?.file).toBe('app/graphql/mutations/books/lend.rb');
  });

  it('follows Ruby: the last mixin before an earlier one, a class before both', async () => {
    const back = (await server({
      'app/graphql/types/pages/first.rb':
        'module Types\n  module Pages\n    module First\n      def label\n        1\n      end\n    end\n  end\nend\n',
      'app/graphql/types/pages/second.rb':
        'module Types\n  module Pages\n    module Second\n      def label\n        2\n      end\n    end\n  end\nend\n',
      'app/graphql/types/shelf.rb': `module Types
  class Shelf < Types::Base
    include Types::Pages::First
    include Types::Pages::Second
    field :id, ID, null: false, resolver_method: :label
    field :name, String, null: false
    def name
      object.name
    end
  end
end
`,
    }))!;
    const { links } = linkContracts([
      ['back', back],
      ['web', (await client({ 'S.graphql': 'query S { shelf(id: "1") { id name } }' }))!],
    ]);
    const answers = new Map(links.map((l) => [l.field, l.provider]));
    expect(answers.get('Shelf.id')?.file).toBe('app/graphql/types/pages/second.rb');
    expect(answers.get('Shelf.name')?.symbol).toBe('Types::Shelf#name');
  });

  it('tells apart two classes of one type name by the fields of the schema', async () => {
    const nested = (ns: string, fields: string[]) =>
      `module Resolvers\n  module ${ns}\n    class Root < Base\n      class ThingsQuery < Types::Base\n${fields.map((f) => `        field :${f}, resolver: Resolvers::${ns}::${f[0]!.toUpperCase()}${f.slice(1)}\n`).join('')}      end\n    end\n    class Find < Base\n      def resolve\n        1\n      end\n    end\n  end\nend\n`;
    const facts = (await client({
      Gemfile: "gem 'graphql'\n",
      'a/public.rb': nested('Open', ['find', 'list', 'count']),
      'a/admin.rb': nested('Staff', ['find']),
      'site.graphql':
        'type Query { things: ThingsQuery } type ThingsQuery { find: Int list: Int count: Int }',
    }))!;
    const op = (await client({ 'Op.graphql': 'query Op { things { find } }' }))!;
    const { links } = linkContracts([
      ['back', facts],
      ['web', op],
    ]);
    expect(links.find((l) => l.field === 'ThingsQuery.find')?.provider.symbol).toBe(
      'Resolvers::Open::Find#resolve'
    );
  });

  it('marks an operation several schemas fit, naming different code, as unsure', async () => {
    const nested = (ns: string) =>
      `module Resolvers\n  module ${ns}\n    class Q < Base\n      graphql_name '${ns}Query'\n      field :find, resolver: Resolvers::${ns}::Find\n    end\n    class Find < Base\n      def resolve\n        1\n      end\n    end\n  end\nend\n`;
    const back = (await client({
      Gemfile: "gem 'graphql'\n",
      'a.rb': nested('A'),
      'b.rb': nested('B'),
      'a.graphql': 'type Query { all: AQuery } type AQuery { find: Int }',
      'b.graphql': 'type Query { all: BQuery } type BQuery { find: Int }',
    }))!;
    const { links } = linkContracts([
      ['back', back],
      ['web', (await client({ 'Op.graphql': 'query Op { all { find } } ' }))!],
    ]);
    const finds = links.filter((l) => l.field.endsWith('.find'));
    expect(finds.map((l) => l.provider.symbol).sort()).toEqual([
      'Resolvers::A::Find#resolve',
      'Resolvers::B::Find#resolve',
    ]);
  });

  it('prefers the schema a client holds a copy of, of those fitting alike', async () => {
    const nested = (ns: string) =>
      `module Resolvers\n  module ${ns}\n    class Q < Base\n      graphql_name '${ns}Query'\n      field :find, resolver: Resolvers::${ns}::Find\n    end\n    class Find < Base\n      def resolve\n        1\n      end\n    end\n  end\nend\n`;
    const schemaB = 'type Query { all: BQuery } type BQuery { find: Int }';
    const back = (await client({
      Gemfile: "gem 'graphql'\n",
      'a.rb': nested('A'),
      'b.rb': nested('B'),
      'a.graphql': 'type Query { all: AQuery } type AQuery { find: Int }',
      'b.graphql': schemaB,
    }))!;
    const { links } = linkContracts([
      ['back', back],
      [
        'web',
        (await client({ 'schema.graphql': schemaB, 'Op.graphql': 'query Op { all { find } }' }))!,
      ],
    ]);
    const finds = links.filter((l) => l.field.endsWith('.find'));
    expect(finds.map((l) => l.provider.symbol)).toEqual(['Resolvers::B::Find#resolve']);
    expect(finds[0]?.certain).toBe(true);
  });

  it('reads a document against the schema its code generator names', async () => {
    const shared = (root: string) => `type Query { all: ${root} } type ${root} { find: Int }`;
    const web = (await client({
      'schemas/site.graphql': shared('SiteQuery'),
      'schemas/staff.graphql': shared('StaffQuery'),
      'codegen.ts': `const config = { schema: "schemas/site.graphql", documents: ["src/**/*.graphql", "!src/[(]staff[)]/**"] };`,
      'codegen.staff.ts': `const config = {\n  documents: [\n    "src/[(]staff[)]/**/*.graphql", // the staff pages\n  ],\n  schema: "schemas/staff.graphql",\n};`,
      'src/One.graphql': 'query One { all { find } }',
      'src/(staff)/Two.graphql': 'query Two { all { find } }',
    }))!;
    expect(web.documentSchemas).toEqual({
      'src/One.graphql': 'schemas/site.graphql',
      'src/(staff)/Two.graphql': 'schemas/staff.graphql',
    });
    const back = (await client({
      's.graphql': shared('SiteQuery'),
      't.graphql': shared('StaffQuery'),
    }))!;
    const fields = linkContracts([
      ['back', back],
      ['web', web],
    ])
      .links.filter((l) => l.field.endsWith('.find'))
      .map((l) => `${l.operation.name} ${l.field}`);
    expect(fields.sort()).toEqual(['One SiteQuery.find', 'Two StaffQuery.find']);
  });

  it('uses arguments to tell schemas apart', async () => {
    const schemas = (await client({
      'a.graphql': 'type Query { find(id: ID): Int }',
      'b.graphql': 'type Query { find(query: String): Int }',
    }))!;
    const fit = linkContracts([
      ['back', schemas],
      ['web', (await client({ 'Op.graphql': 'query Op { find(query: "x") }' }))!],
    ]);
    expect(fit.links.map((l) => l.provider.file)).toEqual(['b.graphql']);
  });

  it('leaves out an operation no schema fits, a call to an outside API', async () => {
    const { links, unmatched } = linkContracts([
      ['back', (await server())!],
      ['web', (await client({ 'Ext.graphql': 'query Outside { weather { today } }' }))!],
    ]);
    expect(links).toEqual([]);
    expect(unmatched.map((o) => o.name)).toEqual(['Outside']);
  });

  it('points at the schema when the server code was not found', async () => {
    const { links } = linkContracts([
      ['back', (await client({ 's.graphql': 'type Query { only: Int }' }))!],
      ['web', (await client({ 'O.graphql': 'query O { only }' }))!],
    ]);
    expect(links[0]?.provider).toEqual({ project: 'back', file: 's.graphql', line: 0 });
  });

  it('links nothing without operations or schemas', () => {
    const none: GraphqlFacts = { documents: [], schemas: [], classes: [], uses: {} };
    expect(linkContracts([['a', none]])).toEqual({
      links: [],
      unmatched: [],
      fieldsWithoutCode: [],
    });
  });
});

describe('what the tools say', () => {
  const contracts = async () =>
    linkContracts([
      [
        'back',
        (await server({ 'spec/books_spec.graphql': 'query SpecFind { books { find { id } } }' }))!,
      ],
      [
        'web',
        (await client({
          'src/FindBooks.query.graphql': FIND,
          'src/List.tsx': 'const r = useQuery(FindBooksDocument);\n',
        }))!,
      ],
    ]);

  const resolver = {
    project: 'back',
    file: 'app/graphql/resolvers/books/find.rb',
    startLine: 2,
    endLine: 7,
    step: 0,
  };

  it('change_impact lists the operations reaching the code, tests apart', async () => {
    const { text, tests } = apiImpact(await contracts(), [resolver]);
    expect(text).toContain('### Through the API (1 operation in 1 file of `web`)');
    expect(text).toContain('`BooksQuery.find`, answered by `Resolvers::Books::Find#resolve`');
    expect(text).toContain('**[web] src/FindBooks.query.graphql:1** query `FindBooks`');
    expect(text).toContain('used in `src/List.tsx:1`');
    expect(tests).toContain('[back] spec/books_spec.graphql');
  });

  it('follows a dependent only through the methods reaching the change', async () => {
    const c = await contracts();
    const at = { ...resolver, step: 2 };
    expect(apiImpact(c, [{ ...at, methods: ['resolve'] }]).text).toContain(
      '2 steps from the change'
    );
    expect(apiImpact(c, [{ ...at, methods: ['helper'] }]).text).toBe('');
  });

  it('narrows to a name', async () => {
    const c = await contracts();
    const book = {
      project: 'back',
      file: 'app/graphql/types/book.rb',
      startLine: 0,
      endLine: 20,
      step: 0,
    };
    const named = apiImpact(c, [{ ...book, name: 'title' }]).text;
    expect(named).toContain('`Book.title`');
    expect(named).not.toContain('`Book.id`');
    expect(apiImpact(c, [book]).text).toContain('`Book.id`');
  });

  it('says nothing about code no operation reaches', async () => {
    const c = await contracts();
    expect(apiImpact(c, [{ ...resolver, file: 'app/other.rb' }])).toEqual({ text: '', tests: '' });
  });

  it('find_usages names the server code a chunk sends a request to', async () => {
    const text = apiCalls(await contracts(), {
      project: 'web',
      file: 'src/List.tsx',
      startLine: 0,
      endLine: 3,
      content: 'const r = useQuery(FindBooksDocument);',
    });
    expect(text).toContain('query `FindBooks`');
    expect(text).toContain('**[back] app/graphql/resolvers/books/find.rb:4**');
    expect(
      apiCalls(await contracts(), {
        project: 'web',
        file: 'src/List.tsx',
        startLine: 5,
        endLine: 6,
        content: 'const other = 1;',
      })
    ).toBe('');
  });

  it('module_map lists who calls whom, without a project on itself', async () => {
    const text = repositoryLinks(await contracts(), { show: (p) => p, diagram: true });
    expect(text).toContain('**`web` → `back`**: GraphQL, 1 operation in 1 file');
    expect(text).toContain('`Resolvers::Books::Find#resolve` (1)');
    expect(text).not.toContain('`back` → `back`');
    expect(text).toContain('-->|GraphQL|');
  });

  it('module_map of one project lists only its links', async () => {
    const c = await contracts();
    expect(repositoryLinks(c, { project: 'web', show: (p) => p, diagram: false })).toContain(
      '`web` → `back`'
    );
    expect(repositoryLinks(c, { project: 'other', show: (p) => p, diagram: false })).toBe('');
  });

  it('hides projects outside the scope', async () => {
    const c = visibleContracts(await contracts(), (p) => p !== 'web');
    expect(repositoryLinks(c, { show: (p) => p, diagram: false })).toBe('');
    expect(apiImpact(c, [resolver]).text).toBe('');
  });
});
