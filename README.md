# Ruby on Rails и PostgreSQL: мультидоменность

В интернете можно найти много похожих между собой статей, в которых говорится, как реализоать мультидоменность приложения на RoR, используя схемы PostgreSQL. Например, [эта](http://railscasts.com/episodes/389-multitenancy-with-postgresql?view=asciicast) и [эта](http://jerodsanto.net/2011/07/building-multi-tenant-rails-apps-with-postgresql-schemas/). Лично я в качестве основы использовал код из railscast. Но при практической реализации какого-либо варианта возникает множество проблем. В данной статье будут описаны некоторые из таких проблем и мои способы их решения.

## Кеширование в переменных

Чтобы минимизировать количесвтво обращений к базе данных или чтобы лишний раз не выполнять инициализацию одних и тех же объектов неоторые вещи выгодно рассчитывать один раз и инициализировать, например, так: 
	
    def parse(*args)
      @connection ||= Connection.new
      @connection.parse
    end

Такое решение можно назвать кешированием в переменных, и при создании мультидоменности за этим нужно пристально следить. Вот [статья](http://timnew.me/blog/2012/07/17/use-postgres-multiple-schema-database-in-rails/)<a href="http://timnew.me/blog/2012/07/17/use-postgres-multiple-schema-database-in-rails/">статья</a>, в которой автор описывает свой опыт, когда он ошибся, используя для задания search_path прямым обращеним к базе данных через

    ActiveRecord::Base.connection.execute "SET search_path TO #{schema};"

вместо использования

    ActiveRecord::Base.connection.schema_search_path schema

В ядре Rails используется как раз второй вариант, в котором происходит кеширование search_path в переменной. Соответственно, джемы часто не знали, что search_path в базе другой, что и приводило к ошибкам.

## Расширения postgresql и индексы

При создании таблиц индекcы можно создавать тремя способами:

    create_table :test do |t|
      t.integer :data, index: true
      t.integer :start_time
      t.integer :end_time
    end

    add_index :test, :start_time
    execute 'create index end_time_index on test (end_time integer);'

При вызове add_index (в первом случае этот метод так же вызывается), происходит такая [проверка](http://edgeapi.rubyonrails.org/classes/ActiveRecord/ConnectionAdapters/PostgreSQLAdapter/SchemaStatements.html#method-i-index_name_exists-3F):

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

Таким образом смотрится, есть ли индекс с указанным названием в <big>любой</big> схеме, а не только в первой из списка search_path. Алгоритм создания нового домена следующий:

* Создать доменную схему
* Включить её в search_path
* Выполнить миграцию

Но миграция может завершиться с ошибкой, потому что search_path на этом этапе обычно 'tenant1,public', и index_name_exists? будет true, если в public схеме уже есть какая-либо таблица с индексом.

Вариантов выхода из ситуации два.

Первый - во всех миграциях не использовать index: true при создании таблиц и add_index, а использовать execute('create index ...'). Этот вариант не удобен: банально долго писать. К тому же, что если мультидоменность создаётся на уже существующем проекте с большим количеством уже готовых миграций, то в них во всех придётся переписывать создание индексов.

Второй вариант - не добавлять public схему в search_path при миграциях. То есть search_path в нашем случае будет 'tenant1'. Но если не добавлять public, возникает другая проблема. По умолчанию расширения postgres ставятся в public схему, и поэтому может возникнуть ошибка, что, к примеру, тип данных 'hstore' не найден (при использовании расшения hstore). Кроме того нельзя поставить расширение ещё раз, но в другую схему (tenant1). Такова особенность postgres: расширение ставится в какую-то схему, но повторно савить его в другие нельзя. Решение этой проблемы - ставить расширения PostgreSQL в отдельную схему, и постоянно включать её в search_path.

Я решил воспользоваться вторым вариантом, создал специальную схему для установки в неё расширений и подключаю её всегда. Перед миграцией search_path='tenant1,extensions', во время обычной работы - 'tenant1,oublic,extensions'. Настройку базы и ролей делаю так:

    sudo -u postgres psql -c "CREATE SCHEMA extensions" template1
    sudo -u postgres psql -c "CREATE EXTENSION hstore WITH SCHEMA extensions" template1
    sudo -u postgres psql -c "CREATE EXTENSION pg_trgm WITH SCHEMA extensions" template1
    sudo -u postgres psql -c 'ALTER ROLE postgres SET search_path TO "$user", public, extensions'
    sudo -u postgres psql -c "CREATE ROLE prj WITH LOGIN PASSWORD 'qwepoiqwe'"
    sudo -u postgres psql -c 'ALTER ROLE prj SET search_path TO "$user", public, extensions'
    sudo -u postgres psql -c "GRANT USAGE ON SCHEMA extensions TO prj" template1

## Создание тамблиц в доменных и публичной схемах

TODO

self.table_name = 'public.tenants'

structure.sql
	
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
        Rails.cache.dalli.instance_variable_set(:@options, original_cache_options.merge({namespace: schema}))
      end
      block.call(self)
    ensure
      if Rails.cache.is_a?(ActiveSupport::Cache::DalliStore)
        Rails.cache.dalli.instance_variable_set(:@options, original_cache_options)
      end
      self.class.connection.schema_search_path = original_search_path
    end

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

Организация мультидоменности - это скурпулёзный процесс.

TODO