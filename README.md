# Ruby on Rails и PostgreSQL: мультидоменность

В интернете можно найти много похожих между собой статей, в которых говорится, как реализоать мультидоменность приложения на RoR, используя схемы PostgreSQL. Например, [эта](http://railscasts.com/episodes/389-multitenancy-with-postgresql?view=asciicast) и [эта](http://jerodsanto.net/2011/07/building-multi-tenant-rails-apps-with-postgresql-schemas/). Лично я в качестве основы использовал код из railscast. Но при практической реализации какого-либо варианта возникает множество проблем. В данной статье будут описаны некоторые из таких проблем и мои способы их решения.

## Кеширование в переменных

Чтобы минимизировать количесвтво обращений к базе данных или чтобы лишний раз не выполнять инициализацию одних и тех же объектов, некоторые вещи выгодно рассчитывать один раз и инициализировать, например, так: 
	
    def parse(*args)
      @connection ||= Connection.new
      @connection.parse
    end

Такое решение можно назвать кешированием в переменных. Если кеширование в переменных в случае обычного приложения даёт экономию при выполнении долгих или одинаковых операций, то в случае мультидоменности такое кеширование мало применимо. Ведь в разных доменах может использоваться один и тот же код, но инициализация этого кода на каждом домене разная. Вот, например, [статья](http://timnew.me/blog/2012/07/17/use-postgres-multiple-schema-database-in-rails/), в которой автор описывает свой опыт, когда он ошибся, используя для задания search_path прямое обращение к базе данных через

    ActiveRecord::Base.connection.execute "SET search_path TO #{schema};"

вместо использования

    ActiveRecord::Base.connection.schema_search_path schema

В ядре Rails текущая схема базы данных сохраняется в переменной, и чтобы узнать текущую схему, достаточно прочитать эту переменную, а не выполнять запрос к базе данных. Методы schema_search_path= и schema_search_path как раз и созданы для управления и схемой в базе, и облуживанием кеширующей переменной. Когда автор менял схему в базе данных без использования этих методов, библиотеки Rails продолжали ориентироваться на схему из кеширующей переменной, что приводило к ошибкам в работе.

## Расширения postgresql и индексы

При создании одинаковых таблиц в разных схемах postgresql может выозникнуть проблема с индексами.

Индекcы можно создавать тремя способами:

    create_table :test do |t|
      t.integer :data, index: true
      t.integer :start_time
      t.integer :end_time
    end

    add_index :test, :start_time

    execute 'create index end_time_index on test (end_time integer);'

При вызове add_index (в случае `t.integer :data, index: true` этот метод также вызывается), происходит такая [проверка](http://edgeapi.rubyonrails.org/classes/ActiveRecord/ConnectionAdapters/PostgreSQLAdapter/SchemaStatements.html#method-i-index_name_exists-3F):

    def index_name_exists?(table_name, index_name, default)
      exec_query("SELECT COUNT(*)
        FROM pg_class t
        INNER JOIN pg_index d ON t.oid = d.indrelid
        INNER JOIN pg_class i ON d.indexrelid = i.oid
        WHERE i.relkind = 'i'
        AND i.relname = '#{index_name}'
        AND t.relname = '#{table_name}'
        AND i.relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname = ANY (current_schemas(false)) )
      ", 'SCHEMA').rows.first[0].to_i > 0
    end		

То есть смотрится, имеется ли индекс с указанным названием в <big>любой</big> схеме из присутствующих на данный момент в search_path, а не только в первой. Если на момент выполнения миграции в search_path требуется иметь какую-то схему, в которой уже есть индекс с таким же названием, то index_name_exists? будет true, и миграция завершится ошибкой. 
Допустим для определённости, что search_path == 'tenant1,public', и что в public есть конфликтный индекс. Вариантов выхода из ситуации несколько.

Первый - во всех миграциях не использовать при создании таблиц index: true или и add_index, а использовать execute('create index ...'). Этот вариант не удобен: долго писать. К тому же, что если мультидоменность создаётся на уже существующем проекте с большим количеством имеющихся миграций, то в них во всех придётся переписывать создание индексов.

Второй вариант - не добавлять public схему в search_path при миграциях. То есть search_path в нашем случае будет 'tenant1'. Но если не добавлять public, возникает другая проблема. По умолчанию расширения postgres ставятся в public схему, и поэтому может возникнуть ошибка, что, к примеру, тип данных 'hstore' не найден (при использовании расшения hstore). Кроме того нельзя поставить расширение ещё раз, но в другую схему (tenant1). Такова особенность postgres: расширение ставится в какую-то схему, но повторно савить его в другие нельзя. Решение этой проблемы - ставить расширения PostgreSQL в отдельную схему, и постоянно включать её в search_path.

В своём проекте я решил воспользоваться вторым вариантом, создал специальную схему для установки в неё расширений и подключаю её всегда. Перед миграцией search_path='tenant1,extensions', во время обычной работы - 'tenant1,public,extensions'. Настройку базы и ролей делаю так:

    sudo -u postgres psql -c "CREATE SCHEMA extensions" template1
    sudo -u postgres psql -c "CREATE EXTENSION hstore WITH SCHEMA extensions" template1
    sudo -u postgres psql -c "CREATE EXTENSION pg_trgm WITH SCHEMA extensions" template1
    sudo -u postgres psql -c 'ALTER ROLE postgres SET search_path TO "$user", public, extensions'
    sudo -u postgres psql -c "CREATE ROLE prj WITH LOGIN PASSWORD 'qwepoiqwe'"
    sudo -u postgres psql -c 'ALTER ROLE prj SET search_path TO "$user", public, extensions'
    sudo -u postgres psql -c "GRANT USAGE ON SCHEMA extensions TO prj" template1

Можно придумать и другие способы обхода проблемы с индексами. Например, сделать патч с изменением реализации index_name_exists?, или удалить конфликтные индексы из схемы, где они не использутся (например, из public). Пусть каждый решает в зависимости от своих условий.

## Работа с тенантами

При организации мультидоменности нужно:

* Реализовать механизм создания тенана. Он включает создание схемы postgres, а также создание в этой схеме таблиц. 
* Обеспечить функционирование механизма миграций. Для всех существующих тенантов должны работать задачи db:migrate и db:rollback.

### Создание тенанта

В моём проекте было решено сделать процесс создания быстрым. Для этого был реализован метод, который в основном потоке создаёт новую схему, а создание таблиц выполняет исполнением дампа structure.sql, который создаётся при самой первой миграции, когда ещё нет ни одного тенанта, и есть только схема public. Был использован structure.sql, а не schema.rb потому, что в миграциях присутствовали особые запросы к базе данных, которые не описать в написанном на руби schema.rb. Упрощённый код метода таков:

    connection.execute("create schema if not exists #{schema}")
    scope_schema do
      structure_file = "#{Rails.root}/db/structure.sql"
      connection.execute self.class.structure_query(structure_file)
    end

Первая проблема structure.sql в том, что в нём есть команды, которые не должны выполняться при заполнении схемы, например, создание расширений или выставление search_path. Для этого код файла чистится следующим методом:

    def self.structure_query(structure_sql_file)
	  structure_sql = open(structure_sql_file, 'r').read
	  structure_sql = structure_sql.gsub('SET search_path = public, pg_catalog;', '')
	  ...
      # another filters
    end

Вторая проблемя structure.sql в том, как он генерируется. Когда тенантов нет, файл содержит код для создания и заполнения одной схемы - public. Когда имеется одна дополнительная схема тенанта, и выполнена миграция, код в structure.sql содержит команды как для создания и заполнения public, так и для созания и заполнения схемы тенанта tenant1. То есть, чтобы использовать structure.sql для создания очередного тенанта, нужно чистить structure.sql не так, как в самый первый раз. Можно для этого написать более продвинутый алгоритм, но есть способ указать рельсам, какие схемы должны учитываться в structure.sql. Проще всего это сделать в database.yml, указав там schema_search_path

	development:
	  adapter: postgresql
	  database: multitenancy
	  host: localhost
	  port: 5432
	  encoding: utf-8
	  username: vasya
	  password: 123
	  pool: 5
	  timeout: 5000
	  schema_search_path: 'public,extensions'

### Миграции

db:migrate и db:rollback должны выполняться для всех схем тенантов. Это можно сделать так:

	db_tasks = %w[db:migrate db:migrate:up db:migrate:down db:rollback db:forward]

	namespace :multitenant do
	  db_tasks.each do |task_name|
	    desc "Run #{task_name} for each tenant"
	    task task_name => %w[environment db:load_config] do
	      if ActiveRecord::Base.connection.table_exists?(Tenant.table_name)
	        Tenant.scope_each_schema do |tenant|
	          if ActiveRecord::Base.connection.query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '#{table_name}');")[0][0] == 't'
              ActiveRecord::Base.connection.execute("create table #{tenant.schema}.#{table_name} (like public.#{table_name} including all);")
            end

	          Rake::Task[task_name].execute

	          Tenant::PUBLIC_TABLES.each do |table_name|
	            ActiveRecord::Base.connection.execute("drop table if exists #{table_name} cascade;")
	          end
	        end
	      end
	    end
	  end
	end

	db_tasks.each do |task_name|
	  Rake::Task[task_name].enhance(["multitenant:#{task_name}"])
	end

Перед задачами из db_tasks выполняются свои задачи, которые запускают изначально запрашиваемую задачу для каждого из тенантов, предварительно изменив схему postgres. Представленная реализация отличается от той, что обычно преподносится в других статьях. Дело в том, что показанный вариант подразумевает наличие в проекте таблиц, общих для всех тенантов. Такие таблицы можно держать в схеме public, но удалить из схем тенантов, и в search_path всегда добавлять public в конце.
В каком-либо проекте может оказаться, что во время миграции в search_path в силу каких-то причин нельзя иметь public. Тогда задачи миграции могут завершиться с ошибками, если в миграциях идёт обращение к публичной таблице. Кроме того, в таких миграциях может потребоваться не только наличие публичных таблиц, но и может осуществляться какая-то манипуляция с данными этой таблицы. В качестве решения комбинаций такого рода проблем было придумано следующее решение. Перед миграцией в схеме тенанта делаются копии публичных таблиц из схемы public (копируется только структура без данных, так как данных может быть очень много). Зачем выполняется миграция, почле чего публичнаые таблицы из схемы тенанта удаляются. В файлах миграции изменения минимальны: нужно лишь явно указывать схему для публичной таблицы, если требуются данные из такой таблицы. Для этого можно использовать как сырые sql запросы, так и явно определив   self.table_name в модели.

    self.table_name = 'public.tenants'

Миграция для схемы public выполняется после выполнения миграций в схемах тенантов, чтобы данные публичных таблиц, используемые в миграциях тенантов, изменялись в последнюю очередь.
	
## Кеш

При использовании полноценного кеша проблемы такие же, как и при применении кеширования в переменных. Кроме того, кеш между доменами следует разделять. Сделать это можно двумя способами.

Первый - это вручную добавлять домен к названиям ключей. Недостаток этого варианта в том, сторонние библиотеки как использовали старые названия ключей, так и будут их использовать. Поэтому, чтобы всё заработало, нужно тщательно пропатчить библиотеки ядра, которые связаны с кешированием.

Второй вариант - использовать неймспейсы (если драйвер кеша их поддерживает). Я использую dalli, в котором можно задавать неймспейс при инициализации, и сам неймспейс - это просто префикс, автоматически добавляемый к ключам. К сожалению, смена неймспейса на лету не поддерживается, поэтому для решения можно написать патч, добаваив к классу Dalli::Client аксессор options, либо напрямую менять переменную инстанса. В итоге для исполнения кода в рамках домена я делаю так:

    def scope_schema(*paths, &block)
      original_search_path = self.class.connection.schema_search_path
      self.class.connection.schema_search_path = [schema, *paths, 'extensions'].join(",")
      if !Rails.cache.is_a?(ActiveSupport::Cache::DalliStore) && !Rails.env.test?
        raise 'Schema scope cache error'
      end
      if Rails.cache.is_a?(ActiveSupport::Cache::DalliStore)
        original_cache_options = Rails.cache.dalli.instance_variable_get(:@options)
        Rails.cache.dalli.instance_variable_set(:@options, original_cache_options.merge({namespace: cache_namespace}))
      end
      block.call(self)
    ensure
      if Rails.cache.is_a?(ActiveSupport::Cache::DalliStore)
        Rails.cache.dalli.instance_variable_set(:@options, original_cache_options)
      end
      self.class.connection.schema_search_path = original_search_path
    end

Есть ещё три момента, которые хотелось бы отметить в теме работы с кешем.

* Если на сервере запускается несколько мультидоменных приложений, а кеш обший, то названия неймспейсов кешей тенантов могут пересекаться между приложениями. Можно это предотвратить, например, используя время создания тенанта в имени неймспейса кеша. 
* Иногда может понадобиться создать глобальный неймспейс в кеше. Напрмер, для работы с таблицами, общими для всех тенантов.
* Если есть задача очистки кеша (например, при деплое), то нужно очишать все неймспейсы. В случае memcached, к примеру, выгодно это делать вызовом команды
	
	echo "flush_all" | /bin/netcat -q 2 127.0.0.1 11211

## Инициализаторы

Код из директории config содержит настройки для всего приложения. В случае мультидоменности у нас как бы нескольк разных приложений, поэтому всё из config подлежит пересмотру на предмет того, что является общим для всех приложений, а что для каждого домена своё. Рассмотрим пример с настрокой почты.

В простом случае без мультидоменности какие-то настройки почты можно вынести в application.rb. К примеру, в этом файле можно указать config.action_mailer.default_options[:from]. В случае мультидоменности для каждого домена, вероятно, придётся указывать разных отправителей. Чтобы это сделать, имеет смысл создать таблицу настроек в базе данных или кеше, где будут храиниться настройки домена. В каждой доменной схеме разумно создать свою таблицу настроек. Настройки из таблицы следует извлекать каждый раз перед отправкой письма. Это можно сделать как в мейлере:

    class UserMailer < ActionMailer::Base
      default Setting.mail_settings[:default_fields]
    end

так и пропатчив ActionMailer::Base (если мейлеров много, ил если нужно чтобы сторонние библиотеки, такие как Devise, отправляли свои уведомления с правильными настройками)

    require 'active_support/concern'

	module ActionMailerBasePatch
		extend ActiveSupport::Concern

		def mail_with_tenant_settings(headers = {}, &block)
	    	self.class.default_url_options[:host] = Setting.host

    		_headers = headers
      		Setting.mail_settings[:default_fields].each do |k,v|
        		_headers[k] = v if _headers[k].blank? && v.present?
      		end

	    	mail_without_tenant_settings(_headers, &block)
	    end

		included do
    		alias_method_chain :mail, :tenant_settings
 		end
	end

    ActionMailer::Base.send(:include, ActionMailerBasePatch)
	
## Заключение

Я показал, как можно подходить к решению некоторых проблем, возникающих при создании мультидоменного приложения. Вариантов решений может быть несколько, и вам самим предстоит выбрать, какие применять. Главное иметь ввиду, что идёт попытка создания как будто совершенно разных приложений, использующих один и тот же код, и которые могут использовать общие данные. Отсюда и все проблемы.